import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand, now, ts } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Housekeeping tasks and the room readiness they produce.
 *
 * Every transition moves the task and the room in one transaction. They are not
 * separable: a task marked CLEANED while the room stays VACANT_DIRTY would tell
 * the front desk a room is sellable when it is not, which is the one failure
 * this module exists to prevent.
 *
 * The task rows deliberately carry no guest reference. `HousekeepingTask` does
 * not relate to `Reservation`, so there is no join available that could leak a
 * guest's identity or a rate into a cleaner-facing payload.
 */

/** Room states a guest may be admitted to. */
const READY_ROOMS = new Set(['VACANT_CLEAN', 'INSPECTED']);

/** The transition each action permits, so an out-of-order call is a 409. */
const ALLOWED: Record<string, string[]> = {
  start: ['TODO'],
  complete: ['IN_PROGRESS'],
  'request-inspection': ['CLEANED'],
  inspect: ['INSPECTION_REQUIRED'],
  block: ['TODO', 'IN_PROGRESS', 'CLEANED', 'INSPECTION_REQUIRED'],
  cancel: ['TODO', 'IN_PROGRESS', 'CLEANED', 'INSPECTION_REQUIRED'],
};

@Injectable()
export class HousekeepingService {
  constructor(private readonly audit: AuditService) {}

  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    const p = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!p) throw new BadRequestException('Active property not found');
    return p;
  }

  /**
   * Lists tasks. Housekeeping sees only what is assigned to them; anyone holding
   * `housekeeping.assign` sees the whole board, which is what a supervisor needs
   * to rebalance the floor.
   */
  async list(req: any, opts: { scope?: string }) {
    const property = await this.property(req);
    const tasks = await db.orm.public.HousekeepingTask
      .where({ propertyId: brand(property.id) })
      .all();

    const mine = opts.scope === 'mine' || !req.user?.permissions?.includes('housekeeping.assign');
    const visible = mine
      ? tasks.filter((t) => t.assignedToId === req.user?.id || t.assignedToId === null)
      : tasks;

    const roomIds = [...new Set(visible.map((t) => t.roomId))];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const userIds = [...new Set(visible.map((t) => t.assignedToId).filter(Boolean))] as string[];
    const users = userIds.length
      ? await db.orm.public.User.where((m) => m.id.in(userIds)).all()
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    return visible
      .map((t) => {
        const room = roomById.get(t.roomId);
        return {
          id: t.id,
          type: t.type,
          status: t.status,
          priority: t.priority,
          roomId: t.roomId,
          roomNumber: room?.roomNumber ?? null,
          floor: room?.floor ?? null,
          wing: room?.wing ?? null,
          roomStatus: room?.status ?? null,
          assignedToId: t.assignedToId,
          assigneeName: t.assignedToId ? nameById.get(t.assignedToId) ?? null : null,
          dueAt: t.dueAt,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
          inspectedAt: t.inspectedAt,
          notes: t.notes,
          blockedReason: t.blockedReason,
          createdAt: t.createdAt,
        };
      })
      .sort((a, b) => {
        const order = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as Record<string, number>;
        const p = (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
        if (p !== 0) return p;
        return String(a.dueAt ?? a.createdAt).localeCompare(String(b.dueAt ?? b.createdAt));
      });
  }

  async create(req: any, input: {
    roomId: string;
    type: string;
    priority?: string;
    assignedToId?: string | null;
    dueAt?: string | null;
    notes?: string | null;
  }) {
    const property = await this.property(req);
    const room = await db.orm.public.Room
      .where({ id: brand(input.roomId), propertyId: brand(property.id) })
      .first();
    if (!room) throw new NotFoundException('Room not found');

    // One open task per room per type. Two cleaners turning over the same room
    // is duplicated effort and produces conflicting room states.
    const open = await db.orm.public.HousekeepingTask
      .where({ roomId: brand(room.id), type: brand(input.type) as never })
      .all();
    const live = open.filter((t) => t.status !== 'READY' && t.status !== 'CANCELLED');
    if (live.length > 0) {
      throw new ConflictException(
        `Room ${room.roomNumber} already has a ${input.type.replace(/_/g, ' ').toLowerCase()} in progress`,
      );
    }

    const task = await db.orm.public.HousekeepingTask.create({
      propertyId: brand(property.id),
      roomId: brand(room.id),
      type: brand(input.type) as never,
      priority: brand(input.priority ?? 'NORMAL') as never,
      status: brand('TODO'),
      assignedToId: brand(input.assignedToId ?? null),
      createdById: brand(req.user?.id ?? null),
      dueAt: input.dueAt ? ts(new Date(input.dueAt)) : null,
      notes: brand(input.notes ?? null),
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'housekeeping.task.create',
      resourceType: 'HousekeepingTask',
      resourceId: task.id,
      outcome: 'SUCCESS',
      metadata: { roomNumber: room.roomNumber, type: input.type, priority: task.priority },
    });

    return { id: task.id, status: task.status, roomNumber: room.roomNumber };
  }

  /** Reassigns a task. Held by `housekeeping.assign`. */
  async assign(req: any, taskId: string, assignedToId: string | null) {
    const task = await this.load(taskId);
    if (task.status === 'READY' || task.status === 'CANCELLED') {
      throw new ConflictException(`A ${task.status} task cannot be reassigned`);
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.HousekeepingTask.where({ id: brand(taskId) }).update({
        assignedToId: brand(assignedToId),
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: task.propertyId,
          actorUserId: req.user?.id,
          action: 'housekeeping.task.assign',
          resourceType: 'HousekeepingTask',
          resourceId: task.id,
          outcome: 'SUCCESS',
          metadata: { assignedToId },
        },
        tx,
      );
    });

    return { id: taskId, assignedToId };
  }

  /**
   * Moves a task along, updating room readiness in the same transaction.
   *
   * `result` decides what an inspection concludes: `pass` takes the room to a
   * sellable state, `fail` puts it back to dirty for rework.
   */
  private async transition(
    req: any,
    taskId: string,
    action: keyof typeof ALLOWED,
    opts: {
      notes?: string | null;
      reason?: string | null;
      result?: 'pass' | 'fail';
      roomStatus?: (current: string, occupied: boolean) => string;
    } = {},
  ) {
    const task = await this.load(taskId);
    const room = await db.orm.public.Room.where({ id: brand(task.roomId) }).first();
    if (!room) throw new NotFoundException('Room not found');

    const allowed = ALLOWED[action] ?? [];
    if (!allowed.includes(task.status)) {
      throw new ConflictException(
        `Cannot ${action.replace('-', ' ')} a ${task.status.replace(/_/g, ' ').toLowerCase()} task`,
      );
    }

    const occupied = room.status.startsWith('OCCUPIED');
    const patch: Record<string, unknown> = {};
    let nextRoomStatus: string | null = null;

    switch (action) {
      case 'start':
        patch.status = brand('IN_PROGRESS');
        patch.startedAt = now();
        break;

      case 'complete':
        patch.status = brand('CLEANED');
        patch.completedAt = now();
        // A stayover clean is done in an occupied room, so it cannot make the
        // room sellable. Only a room that was vacant becomes clean here.
        nextRoomStatus = occupied ? 'OCCUPIED_CLEAN' : 'VACANT_CLEAN';
        break;

      case 'request-inspection':
        patch.status = brand('INSPECTION_REQUIRED');
        break;

      case 'inspect':
        if (opts.result === 'fail') {
          patch.status = brand('INSPECTION_REQUIRED');
          patch.inspectedAt = now();
          nextRoomStatus = occupied ? 'OCCUPIED_DIRTY' : 'VACANT_DIRTY';
        } else {
          patch.status = brand('READY');
          patch.inspectedAt = now();
          // INSPECTED means ready to sell, which an occupied room never is.
          nextRoomStatus = occupied ? 'OCCUPIED_CLEAN' : 'INSPECTED';
        }
        break;

      case 'block':
        if (!opts.reason?.trim()) {
          throw new BadRequestException('Blocking a task requires a reason');
        }
        patch.status = brand('BLOCKED');
        patch.blockedReason = brand(opts.reason.trim());
        break;

      case 'cancel':
        patch.status = brand('CANCELLED');
        break;
    }

    if (opts.notes !== undefined && opts.notes !== null) {
      patch.notes = brand(opts.notes);
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.HousekeepingTask.where({ id: brand(taskId) }).update(patch);
      if (nextRoomStatus) {
        await tx.orm.public.Room.where({ id: brand(room.id) }).update({
          status: brand(nextRoomStatus) as never,
        });
      }
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: task.propertyId,
          actorUserId: req.user?.id,
          action: `housekeeping.task.${action}`,
          resourceType: 'HousekeepingTask',
          resourceId: task.id,
          reason: opts.reason?.trim() ?? null,
          outcome: 'SUCCESS',
          metadata: {
            roomNumber: room.roomNumber,
            from: task.status,
            to: String(patch.status ?? task.status),
            roomStatusBefore: room.status,
            roomStatusAfter: nextRoomStatus ?? room.status,
          },
        },
        tx,
      );
    });

    return {
      id: taskId,
      status: String(patch.status ?? task.status),
      roomNumber: room.roomNumber,
      roomStatus: nextRoomStatus ?? room.status,
      roomReady: nextRoomStatus ? READY_ROOMS.has(nextRoomStatus) : READY_ROOMS.has(room.status),
    };
  }

  start(req: any, taskId: string) {
    return this.transition(req, taskId, 'start');
  }

  complete(req: any, taskId: string, notes?: string | null) {
    return this.transition(req, taskId, 'complete', { notes });
  }

  requestInspection(req: any, taskId: string) {
    return this.transition(req, taskId, 'request-inspection');
  }

  inspect(req: any, taskId: string, result: 'pass' | 'fail', notes?: string | null) {
    return this.transition(req, taskId, 'inspect', { result, notes });
  }

  block(req: any, taskId: string, reason: string) {
    return this.transition(req, taskId, 'block', { reason });
  }

  cancel(req: any, taskId: string, reason: string) {
    return this.transition(req, taskId, 'cancel', { reason });
  }

  /** Household-level totals, used by the board header. */
  async boardSummary(req: any) {
    const tasks = await this.list(req, {});
    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    const property = await this.property(req);
    const rooms = await db.orm.public.Room
      .where({ propertyId: brand(property.id) })
      .all();
    const active = rooms.filter((r) => r.isActive);

    return {
      byStatus,
      rooms: {
        total: active.length,
        ready: active.filter((r) => READY_ROOMS.has(r.status)).length,
        dirty: active.filter((r) => r.status.endsWith('DIRTY')).length,
        occupied: active.filter((r) => r.status.startsWith('OCCUPIED')).length,
        outOfOrder: active.filter((r) => r.status === 'OUT_OF_ORDER').length,
      },
    };
  }

  private async load(taskId: string) {
    const task = await db.orm.public.HousekeepingTask.where({ id: brand(taskId) }).first();
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }
}