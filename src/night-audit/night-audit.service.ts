import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand, json, now, ts } from '../prisma/compat.js';
import { addDays, businessDateFor, enumerateNights, type DateOnly } from '../common/dates.js';
import { fromDecimal, toDecimal } from '../common/money.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Night audit.
 *
 * Closing is **advisory**: it records that a supervisor reviewed a business date
 * and accepted its exceptions. Nothing is locked, because the schema has nowhere
 * to record a lock and inventing one here would silently start refusing writes
 * in paths this phase does not own.
 *
 * That makes the preview/close pair the point. Preview shows what does not add
 * up; close is the signature saying somebody looked at it. Both are audited, so
 * the attestation has an author and a timestamp.
 *
 * The property's timezone defines the business date, not the server clock.
 */
@Injectable()
export class NightAuditService {
  constructor(private readonly audit: AuditService) {}

  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    const p = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!p) throw new BadRequestException('Active property not found');
    return p;
  }

  private async validateDate(req: any, businessDate: string) {
    const property = await this.property(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? '')) {
      throw new BadRequestException('Business date must be YYYY-MM-DD');
    }
    const today = businessDateFor(property.timezone);
    // Closing a future date is meaningless; there is nothing to audit yet.
    if (businessDate > today) {
      throw new BadRequestException(
        `${businessDate} is in the future; the business date today is ${today}`,
      );
    }
    return { property, today };
  }

  /**
   * Runs the five checks the kit specifies and stores the result.
   *
   * Every figure comes from the same tables the operational screens use, so a
   * night audit that disagrees with the arrivals list would show up as an
   * exception here rather than passing quietly.
   */
  async preview(req: any, businessDate: string) {
    const { property } = await this.validateDate(req, businessDate);

    const nextDay = addDays(businessDate as DateOnly, 1) as DateOnly;
    const nights = enumerateNights(businessDate as DateOnly, nextDay);

    const reservations = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id) })
      .all();

    const guestsIn = reservations.filter(
      (r) => r.status !== 'CANCELLED' && nights.includes(String(r.checkInDate).slice(0, 10) as DateOnly),
    );
    const guestsOut = reservations.filter(
      (r) => r.status !== 'CANCELLED' && nights.includes(String(r.checkOutDate).slice(0, 10) as DateOnly),
    );
    const stillIn = reservations.filter((r) => r.status === 'CHECKED_IN');

    // A stay that should have departed on this date but is still marked in
    // house: either a late departure or a missed checkout.
    const overdueDepartures = stillIn.filter(
      (r) => String(r.checkOutDate).slice(0, 10) <= businessDate,
    );

    const lines = reservations.length
      ? await db.orm.public.ReservationRoom
          .where((m) => m.reservationId.in(reservations.map((r) => r.id)))
          .all()
      : [];
    const roomIds = [...new Set(lines.map((l) => l.roomId).filter(Boolean))] as string[];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomNumberById = new Map(rooms.map((r) => [r.id, r.roomNumber]));

    const folios = reservations.length
      ? await db.orm.public.Folio.where((m) => m.reservationId.in(reservations.map((r) => r.id))).all()
      : [];
    const items = folios.length
      ? await db.orm.public.FolioItem.where((m) => m.folioId.in(folios.map((f) => f.id))).all()
      : [];
    const payments = folios.length
      ? await db.orm.public.Payment.where((m) => m.folioId.in(folios.map((f) => f.id))).all()
      : [];

    const itemsByFolio = new Map<string, typeof items>();
    for (const i of items) {
      if (!itemsByFolio.has(i.folioId)) itemsByFolio.set(i.folioId, []);
      itemsByFolio.get(i.folioId)!.push(i);
    }
    const paymentsByFolio = new Map<string, typeof payments>();
    for (const p of payments) {
      if (!paymentsByFolio.has(p.folioId)) paymentsByFolio.set(p.folioId, []);
      paymentsByFolio.get(p.folioId)!.push(p);
    }

    const describe = (r: any) => {
      const line = lines.find((l) => l.reservationId === r.id);
      return {
        reservationId: r.id,
        bookingCode: r.bookingCode,
        roomNumber: line?.roomId ? roomNumberById.get(line.roomId) ?? null : null,
        checkInDate: String(r.checkInDate).slice(0, 10),
        checkOutDate: String(r.checkOutDate).slice(0, 10),
        status: r.status,
      };
    };

    // 1. Expected movement on this business date.
    const movement = {
      expectedArrivals: guestsIn.filter((r) => r.status === 'CONFIRMED').map(describe),
      expectedDepartures: guestsOut.filter((r) => r.status === 'CHECKED_IN').map(describe),
    };

    // 2. Stays that should have ended but are still in house.
    const activeStays = {
      count: stillIn.length,
      overdue: overdueDepartures.map(describe),
    };

    // 3. Folios with no live charge at all, which usually means something was
    //    posted against the wrong folio.
    const openFolios = folios.filter((f) => f.status === 'OPEN');
    const unpostedCharges = openFolios
      .filter((f) => {
        const live = (itemsByFolio.get(f.id) ?? []).filter((i) => !i.isVoided);
        return live.length === 0;
      })
      .map((f) => {
        const r = reservations.find((x) => x.id === f.reservationId);
        return { folioId: f.id, folioNo: f.folioNo, bookingCode: r?.bookingCode ?? null };
      });

    // 4. Balances, so a supervisor can see what is outstanding at close.
    const outstanding = folios.map((f) => {
      const live = (itemsByFolio.get(f.id) ?? []).filter((i) => !i.isVoided);
      const charges = live.reduce((a, i) => a + fromDecimal(String(i.totalAmount)).minor, 0);
      const tax = live.reduce((a, i) => a + fromDecimal(String(i.taxAmount ?? 0)).minor, 0);
      let paid = 0;
      for (const p of paymentsByFolio.get(f.id) ?? []) {
        if (p.status === 'PENDING' || p.status === 'FAILED') continue;
        paid += fromDecimal(String(p.amount)).minor;
        if (p.refundedAmount) paid -= fromDecimal(String(p.refundedAmount)).minor;
      }
      return {
        folioId: f.id,
        folioNo: f.folioNo,
        status: f.status,
        total: toDecimal({ minor: charges + tax }),
        paid: toDecimal({ minor: paid }),
        balance: toDecimal({ minor: charges + tax - paid }),
      };
    });

    // 5. Payment discrepancies: a settled payment with no folio charge, or a
    //    folio paid beyond its total. Both mean the ledger does not add up.
    const discrepancies: { folioNo: string; kind: string; detail: string }[] = [];
    for (const o of outstanding) {
      const row = outstanding.find((x) => x.folioId === o.folioId)!;
      const settled = (paymentsByFolio.get(o.folioId) ?? []).filter(
        (p) => p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED' || p.status === 'REFUNDED',
      ).length;
      const totalMinor = fromDecimal(row.total).minor;
      const paidMinor = fromDecimal(row.paid).minor;

      if (settled > 0 && totalMinor === 0) {
        discrepancies.push({
          folioNo: o.folioNo,
          kind: 'PAYMENT_WITHOUT_CHARGE',
          detail: 'Money was taken against a folio that carries no charge.',
        });
      }
      if (paidMinor > totalMinor) {
        discrepancies.push({
          folioNo: o.folioNo,
          kind: 'OVERPAID',
          detail: `Collected ${row.paid} against a total of ${row.total}.`,
        });
      }
      if (paidMinor < 0) {
        discrepancies.push({
          folioNo: o.folioNo,
          kind: 'NET_REFUND_EXCEEDS',
          detail: `Refunds exceed the payments taken (${row.paid}).`,
        });
      }
    }

    const summary = {
      businessDate,
      propertyId: property.id,
      generatedAt: now(),
      counts: {
        expectedArrivals: movement.expectedArrivals.length,
        expectedDepartures: movement.expectedDepartures.length,
        activeStays: activeStays.count,
        overdueDepartures: activeStays.overdue.length,
        openFolios: openFolios.length,
        foliosWithNoCharge: unpostedCharges.length,
        paymentDiscrepancies: discrepancies.length,
      },
      movement,
      activeStays,
      unpostedCharges,
      outstanding: outstanding.filter((o) => Number(o.balance) !== 0),
      discrepancies,
      // A single number a supervisor can read at a glance before deciding
      // whether this night needs a conversation.
      exceptionCount:
        activeStays.overdue.length + unpostedCharges.length + discrepancies.length,
    };

    const record = await this.upsert(req, businessDate, 'PREVIEWED', summary, undefined);
    return { ...summary, auditId: record.id, status: record.status };
  }

  private async upsert(
    req: any,
    businessDate: string,
    status: string,
    summary: unknown,
    idempotencyKey?: string | null,
    completed = false,
  ) {
    const property = await this.property(req);
    const existing = await db.orm.public.NightAudit
      .where({ propertyId: brand(property.id) })
      .all();
    const current = existing.find((a) => String(a.businessDate).slice(0, 10) === businessDate);

    if (current) {
      await db.orm.public.NightAudit.where({ id: brand(current.id) }).update({
        status: brand(status) as never,
        previewSummary: completed
          ? brand(null)
          : (json(summary) as never),
        finalSummary: completed ? (json(summary) as never) : current.finalSummary,
        idempotencyKey: idempotencyKey ? brand(idempotencyKey) : current.idempotencyKey,
        startedById: current.startedById ?? brand(req.user?.id ?? null),
        completedById: completed ? brand(req.user?.id ?? null) : current.completedById,
        startedAt: current.startedAt ?? now(),
        completedAt: completed ? now() : current.completedAt,
      });
      const refreshed = await db.orm.public.NightAudit.where({ id: brand(current.id) }).first();
      return refreshed ?? current;
    }

    return db.orm.public.NightAudit.create({
      propertyId: brand(property.id),
      businessDate: ts(new Date(`${businessDate}T00:00:00Z`)),
      status: brand(status) as never,
      startedById: brand(req.user?.id ?? null),
      completedById: completed ? brand(req.user?.id ?? null) : brand(null),
      previewSummary: completed ? brand(null) : (json(summary) as never),
      finalSummary: completed ? (json(summary) as never) : brand(null),
      idempotencyKey: idempotencyKey ? brand(idempotencyKey) : brand(null),
      startedAt: now(),
      completedAt: completed ? now() : brand(null),
    });
  }

  /**
   * Closes the business date.
   *
   * Idempotent on the supplied key: a retried close returns the existing record
   * rather than opening a second one. A *different* key on an already-closed
   * date is refused, because two different runs "closing" the same night is a
   * disagreement someone needs to resolve, not something to paper over.
   */
  async close(req: any, businessDate: string, idempotencyKey: string) {
    const { property } = await this.validateDate(req, businessDate);
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Closing a business date requires an idempotency key');
    }

    const existingRows = await db.orm.public.NightAudit
      .where({ propertyId: brand(property.id) })
      .all();
    const current = existingRows.find((a) => String(a.businessDate).slice(0, 10) === businessDate);

    if (current?.status === 'COMPLETED') {
      if (current.idempotencyKey === idempotencyKey) {
        return { idempotent: true, id: current.id, status: current.status, businessDate };
      }
      throw new ConflictException(
        `${businessDate} was already closed under a different request. Reopen it before closing again.`,
      );
    }

    // Recompute at close time rather than trusting the stored preview: the night
    // may have moved on since it was run.
    const preview = await this.preview(req, businessDate);

    const record = await this.upsert(req, businessDate, 'COMPLETED', preview, idempotencyKey, true);

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'night-audit.close',
      resourceType: 'NightAudit',
      resourceId: record.id,
      outcome: 'SUCCESS',
      metadata: {
        businessDate,
        exceptionCount: preview.exceptionCount,
        idempotencyKey,
        advisoryOnly: true,
      },
    });

    return {
      idempotent: false,
      id: record.id,
      status: 'COMPLETED',
      businessDate,
      exceptionCount: preview.exceptionCount,
      advisoryOnly: true,
    };
  }

  /**
   * Reopens a closed date.
   *
   * The kit's state machine includes REOPENED but lists no endpoint for it, the
   * same gap as task inspection and ticket closing.
   */
  async reopen(req: any, businessDate: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('Reopening a night audit requires a reason');

    const { property } = await this.validateDate(req, businessDate);
    const rows = await db.orm.public.NightAudit
      .where({ propertyId: brand(property.id) })
      .all();
    const current = rows.find((a) => String(a.businessDate).slice(0, 10) === businessDate);
    if (!current) throw new NotFoundException('No night audit for that business date');
    if (current.status !== 'COMPLETED') {
      throw new ConflictException(`A ${current.status} night audit cannot be reopened`);
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.NightAudit.where({ id: brand(current.id) }).update({
        status: brand('REOPENED') as never,
        completedAt: brand(null),
        reopenedAt: now(),
        reopenReason: brand(trimmed),
        idempotencyKey: brand(null),
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: property.id,
          actorUserId: req.user?.id,
          action: 'night-audit.reopen',
          resourceType: 'NightAudit',
          resourceId: current.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: { businessDate },
        },
        tx,
      );
    });

    return { id: current.id, status: 'REOPENED', businessDate };
  }

  /** The audit record for a date, or null when none has been previewed. */
  async get(req: any, businessDate: string) {
    const { property, today } = await this.validateDate(req, businessDate);
    const rows = await db.orm.public.NightAudit
      .where({ propertyId: brand(property.id) })
      .all();
    const record = rows.find((a) => String(a.businessDate).slice(0, 10) === businessDate);

    if (!record) {
      return { businessDate, status: null, exists: false, today };
    }
    return {
      exists: true,
      id: record.id,
      businessDate,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      reopenedAt: record.reopenedAt,
      reopenReason: record.reopenReason,
      previewSummary: record.previewSummary,
      finalSummary: record.finalSummary,
      today,
    };
  }
}