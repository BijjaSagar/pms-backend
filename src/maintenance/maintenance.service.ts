import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, now } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Maintenance tickets and the out-of-order action.
 *
 * A ticket records a fault; taking the room out of service is a separate,
 * permissioned decision with its own audit entry, because the two are not the
 * same event. Fixing a tap does not return a room to service, and taking a room
 * out of service is not something a ticket should imply on its own.
 */
@Injectable()
export class MaintenanceService {
  constructor(private readonly audit: AuditService) {}

  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    const p = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!p) throw new BadRequestException('Active property not found');
    return p;
  }

  private newTicketNo(): string {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `MX-${stamp}-${String(randomInt(0, 100_000)).padStart(5, '0')}`;
  }

  async list(req: any, opts: { status?: string; priority?: string; mine?: boolean }) {
    const property = await this.property(req);
    let tickets = await db.orm.public.MaintenanceTicket
      .where({ propertyId: brand(property.id) })
      .all();

    if (opts.status) tickets = tickets.filter((t) => t.status === opts.status);
    if (opts.priority) tickets = tickets.filter((t) => t.priority === opts.priority);
    if (opts.mine) tickets = tickets.filter((t) => t.assignedToId === req.user?.id);

    const roomIds = [...new Set(tickets.map((t) => t.roomId).filter(Boolean))] as string[];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const userIds = [...new Set(tickets.flatMap((t) => [t.assignedToId, t.reportedById]).filter(Boolean))] as string[];
    const users = userIds.length
      ? await db.orm.public.User.where((m) => m.id.in(userIds)).all()
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    const order = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as Record<string, number>;

    return tickets
      .map((t) => ({
        id: t.id,
        ticketNo: t.ticketNo,
        title: t.title,
        description: t.description,
        category: t.category,
        priority: t.priority,
        status: t.status,
        roomId: t.roomId,
        roomNumber: t.roomId ? roomById.get(t.roomId)?.roomNumber ?? null : null,
        assignedToId: t.assignedToId,
        assigneeName: t.assignedToId ? nameById.get(t.assignedToId) ?? null : null,
        reportedByName: t.reportedById ? nameById.get(t.reportedById) ?? null : null,
        resolution: t.resolution,
        resolvedAt: t.resolvedAt,
        closedAt: t.closedAt,
        createdAt: t.createdAt,
      }))
      .sort((a, b) => {
        const p = (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
        if (p !== 0) return p;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
  }

  async create(req: any, input: {
    title: string;
    description: string;
    roomId?: string | null;
    category?: string;
    priority?: string;
  }) {
    const property = await this.property(req);
    if (!input.title?.trim()) throw new BadRequestException('A ticket requires a title');
    if (!input.description?.trim()) {
      throw new BadRequestException('A ticket requires a description');
    }

    let room = null;
    if (input.roomId) {
      room = await db.orm.public.Room
        .where({ id: brand(input.roomId), propertyId: brand(property.id) })
        .first();
      if (!room) throw new NotFoundException('Room not found');
    }

    let ticket: any = null;
    for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
      try {
        ticket = await db.orm.public.MaintenanceTicket.create({
          propertyId: brand(property.id),
          roomId: brand(room?.id ?? null),
          ticketNo: brand(this.newTicketNo()),
          title: brand(input.title.trim()),
          description: brand(input.description.trim()),
          category: brand(input.category ?? 'OTHER') as never,
          priority: brand(input.priority ?? 'NORMAL') as never,
          status: brand('OPEN'),
          reportedById: brand(req.user?.id ?? null),
        });
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? '');
        if (msg.includes('MaintenanceTicket_propertyId_ticketNo_key') || /duplicate key/i.test(msg)) {
          continue;
        }
        throw e;
      }
    }
    if (!ticket) {
      throw new ConflictException('Could not allocate a ticket number; please retry');
    }

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'maintenance.ticket.create',
      resourceType: 'MaintenanceTicket',
      resourceId: ticket.id,
      outcome: 'SUCCESS',
      metadata: {
        ticketNo: ticket.ticketNo,
        roomNumber: room?.roomNumber ?? null,
        category: ticket.category,
        priority: ticket.priority,
      },
    });

    return { id: ticket.id, ticketNo: ticket.ticketNo, status: ticket.status };
  }

  private async load(ticketId: string) {
    const ticket = await db.orm.public.MaintenanceTicket
      .where({ id: brand(ticketId) })
      .first();
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  private async move(
    req: any,
    ticketId: string,
    next: string,
    allowedFrom: string[],
    extra: Record<string, unknown>,
    action: string,
    reason?: string | null,
  ) {
    const ticket = await this.load(ticketId);
    if (!allowedFrom.includes(ticket.status)) {
      throw new ConflictException(
        `Cannot move a ${ticket.status.replace(/_/g, ' ').toLowerCase()} ticket to ${next.replace(/_/g, ' ').toLowerCase()}`,
      );
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.MaintenanceTicket.where({ id: brand(ticketId) }).update({
        status: brand(next) as never,
        ...extra,
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: ticket.propertyId,
          actorUserId: req.user?.id,
          action,
          resourceType: 'MaintenanceTicket',
          resourceId: ticket.id,
          reason: reason?.trim() ?? null,
          outcome: 'SUCCESS',
          metadata: { ticketNo: ticket.ticketNo, from: ticket.status, to: next },
        },
        tx,
      );
    });

    return { id: ticketId, ticketNo: ticket.ticketNo, status: next };
  }

  assign(req: any, ticketId: string, assignedToId: string | null) {
    return this.move(
      req, ticketId, 'ASSIGNED',
      ['OPEN', 'REOPENED', 'IN_PROGRESS'],
      { assignedToId: brand(assignedToId) },
      'maintenance.ticket.assign',
    );
  }

  start(req: any, ticketId: string) {
    return this.move(
      req, ticketId, 'IN_PROGRESS',
      ['OPEN', 'ASSIGNED', 'REOPENED'],
      {},
      'maintenance.ticket.start',
    );
  }

  /** Marks the fault fixed. The room is returned to service separately. */
  resolve(req: any, ticketId: string, resolution: string) {
    const trimmed = resolution?.trim();
    if (!trimmed) throw new BadRequestException('Resolving a ticket requires notes');
    return this.move(
      req, ticketId, 'RESOLVED',
      ['OPEN', 'ASSIGNED', 'IN_PROGRESS'],
      { resolution: brand(trimmed), resolvedAt: now() },
      'maintenance.ticket.resolve',
      trimmed,
    );
  }

  close(req: any, ticketId: string, reason?: string | null) {
    return this.move(
      req, ticketId, 'CLOSED',
      ['RESOLVED'],
      { closedAt: now() },
      'maintenance.ticket.close',
      reason,
    );
  }

  /**
   * Reopens a closed ticket. `resolvedAt` is deliberately left in place so the
   * history of what was done and when is not erased by the reopen.
   */
  reopen(req: any, ticketId: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('Reopening a ticket requires a reason');
    return this.move(
      req, ticketId, 'REOPENED',
      ['RESOLVED', 'CLOSED'],
      { closedAt: brand(null) },
      'maintenance.ticket.reopen',
      trimmed,
    );
  }

  // -------------------------------------------------------------- out of order

  /**
   * Takes a room out of service, or puts it back.
   *
   * Refused while a guest is in the room: the room cannot be withdrawn from
   * sale without moving them, and doing it anyway would strand an occupied room
   * that the front desk would then refuse to let anyone leave.
   */
  async setOutOfOrder(req: any, roomId: string, reason: string, back: boolean) {
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        back ? 'Returning a room to service requires a note' : 'Taking a room out of order requires a reason',
      );
    }

    const room = await db.orm.public.Room.where({ id: brand(roomId) }).first();
    if (!room) throw new NotFoundException('Room not found');

    if (back) {
      if (room.status !== 'OUT_OF_ORDER') {
        throw new ConflictException(`Room ${room.roomNumber} is not out of order`);
      }
      await db.transaction(async (tx: any) => {
        await tx.orm.public.Room.where({ id: brand(roomId) }).update({
          // A room coming back needs cleaning before it is sellable, so it
          // returns dirty rather than being declared ready.
          status: brand('VACANT_DIRTY') as never,
        });
        await this.audit.record(
          {
            organizationId: req.user?.organizationId,
            propertyId: room.propertyId,
            actorUserId: req.user?.id,
            action: 'room.back-in-service',
            resourceType: 'Room',
            resourceId: room.id,
            reason: trimmed,
            outcome: 'SUCCESS',
            metadata: { roomNumber: room.roomNumber, from: 'OUT_OF_ORDER', to: 'VACANT_DIRTY' },
          },
          tx,
        );
      });
      return { id: room.id, roomNumber: room.roomNumber, status: 'VACANT_DIRTY' };
    }

    if (room.status === 'OUT_OF_ORDER') {
      return { idempotent: true, id: room.id, roomNumber: room.roomNumber, status: 'OUT_OF_ORDER' };
    }
    if (room.status.startsWith('OCCUPIED')) {
      throw new ConflictException(
        `Room ${room.roomNumber} is occupied. Move the guest out before taking the room out of order.`,
      );
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.Room.where({ id: brand(roomId) }).update({
        status: brand('OUT_OF_ORDER') as never,
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: room.propertyId,
          actorUserId: req.user?.id,
          action: 'room.out-of-order',
          resourceType: 'Room',
          resourceId: room.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: { roomNumber: room.roomNumber, from: room.status, to: 'OUT_OF_ORDER' },
        },
        tx,
      );
    });

    return { idempotent: false, id: room.id, roomNumber: room.roomNumber, status: 'OUT_OF_ORDER' };
  }

  /**
   * The most recent out-of-order reason for a room, for display on the room
   * board.
   *
   * Read straight from the audit trail so the reason has exactly one home. The
   * caller needs only `room.read` for this; `audit-log.read` stays reserved for
   * reading the log itself. Nothing guest- or money-related is returned.
   */
  async outOfOrderReasons(roomIds: string[]): Promise<Map<string, { reason: string; at: string }>> {
    const out = new Map<string, { reason: string; at: string }>();
    if (roomIds.length === 0) return out;

    // AuditLog.resourceId is a nullable varchar rather than a uuid, so the
    // filter is applied here instead of in the query.
    const wanted = new Set(roomIds);
    const rows = await db.orm.public.AuditLog
      .where({ action: brand('room.out-of-order') })
      .all();

    const byRoom = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const id = r.resourceId ? String(r.resourceId) : null;
      if (!id || !wanted.has(id)) continue;
      const prev = byRoom.get(id);
      if (!prev || String(r.createdAt) > String(prev.createdAt)) byRoom.set(id, r);
    }

    for (const [roomId, row] of byRoom) {
      out.set(roomId, { reason: String(row.reason ?? ''), at: String(row.createdAt) });
    }
    return out;
  }
}