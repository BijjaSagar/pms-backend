import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import {
  addDays,
  businessDateFor,
  businessDateOf,
  enumerateNights,
  parseTimestamp,
  type DateOnly,
} from '../common/dates.js';
import { divide, fromDecimal, toDecimal } from '../common/money.js';
import { maskName } from '../common/pii.js';

/**
 * Operational and financial reporting.
 *
 * Two definitions are fixed here because they are the ones that drift between
 * implementations and nobody notices until two managers quote different numbers
 * for the same night:
 *
 *  - **Room revenue** counts `ROOM_CHARGE` folio lines only. Incidentals,
 *    adjustments and tax are real money but are not room revenue, and counting
 *    them would inflate both ADR and RevPAR.
 *  - **Sold and available room-nights** come from `RoomNightInventory`, not from
 *    reservations. That table is what the booking process actually claims, so it
 *    is the only honest source for whether a room was sellable on a night.
 *
 * All money stays in integer minor units and is only divided by a count at the
 * very end, so a rate is never the result of a float division.
 */
@Injectable()
export class ReportsService {
  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    const p = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!p) throw new BadRequestException('Active property not found');
    return p;
  }

  private canSeePii(req: any) {
    return (req.user?.permissions ?? []).includes('guest.pii.read');
  }

  /** Resolves a date range, defaulting to the property's current business date. */
  private async range(req: any, from?: string, to?: string) {
    const property = await this.property(req);
    const today = businessDateFor(property.timezone);
    const start = (from ?? today) as DateOnly;
    const end = (to ?? start) as DateOnly;
    if (end < start) throw new BadRequestException('The end date cannot be before the start date');
    const nights = enumerateNights(start, addDays(end, 1) as DateOnly);
    if (nights.length > 400) {
      throw new BadRequestException('Report ranges are limited to 400 nights');
    }
    return { property, today, start, end, nights };
  }

  private async activeRooms(propertyId: string) {
    const rooms = await db.orm.public.Room.where({ propertyId: brand(propertyId) }).all();
    return rooms.filter((r) => r.isActive);
  }

  private async guestsById(ids: string[]) {
    if (ids.length === 0) return new Map();
    const guests = await db.orm.public.Guest.where((m) => m.id.in(ids)).all();
    return new Map(guests.map((g) => [g.id, g]));
  }

  private name(guest: any, canSeePii: boolean) {
    if (!guest) return null;
    return canSeePii
      ? `${guest.firstName} ${guest.lastName}`
      : maskName(guest.firstName, guest.lastName);
  }

  // ---------------------------------------------------------------- daily flash

  /** The shift handover view: what is happening, and what needs attention. */
  async dailyFlash(req: any, date?: string) {
    const property = await this.property(req);
    const canSeePii = this.canSeePii(req);
    const day = (date ?? businessDateFor(property.timezone)) as DateOnly;

    const reservations = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id) })
      .all();

    const expected = reservations.filter(
      (r) => String(r.checkInDate).slice(0, 10) === day && r.status === 'CONFIRMED',
    );
    const due = reservations.filter(
      (r) => String(r.checkOutDate).slice(0, 10) === day && r.status === 'CHECKED_IN',
    );
    const inHouse = reservations.filter((r) => r.status === 'CHECKED_IN');
    const guests = await this.guestsById([
      ...new Set([...expected, ...due, ...inHouse].map((r) => r.primaryGuestId)),
    ]);

    const rooms = await this.activeRooms(property.id);
    const tasks = await db.orm.public.HousekeepingTask
      .where({ propertyId: brand(property.id) })
      .all();
    const tickets = await db.orm.public.MaintenanceTicket
      .where({ propertyId: brand(property.id) })
      .all();

    const tasksInRange = tasks.filter((t) => businessDateOf(property.timezone, t.dueAt ?? t.createdAt) === day);

    return {
      businessDate: day,
      propertyName: property.name,
      arrivals: expected.map((r) => ({
        id: r.id,
        bookingCode: r.bookingCode,
        guestName: this.name(guests.get(r.primaryGuestId), canSeePii),
        checkOutDate: String(r.checkOutDate).slice(0, 10),
        party: `${r.adults}A${Number(r.children) > 0 ? ` ${r.children}C` : ''}`,
      })),
      departures: due.map((r) => ({
        id: r.id,
        bookingCode: r.bookingCode,
        guestName: this.name(guests.get(r.primaryGuestId), canSeePii),
        checkInDate: String(r.checkInDate).slice(0, 10),
      })),
      inHouseCount: inHouse.length,
      rooms: {
        total: rooms.length,
        ready: rooms.filter((r) => ['VACANT_CLEAN', 'INSPECTED'].includes(r.status)).length,
        dirty: rooms.filter((r) => r.status.endsWith('DIRTY')).length,
        occupied: rooms.filter((r) => r.status.startsWith('OCCUPIED')).length,
        outOfOrder: rooms.filter((r) => r.status === 'OUT_OF_ORDER').length,
      },
      housekeeping: {
        open: tasks.filter((t) => !['READY', 'CANCELLED'].includes(t.status)).length,
        blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
        dueToday: tasksInRange.length,
      },
      maintenance: {
        open: tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length,
        critical: tickets.filter((t) => t.priority === 'CRITICAL' && !['RESOLVED', 'CLOSED'].includes(t.status)).length,
      },
    };
  }

  // ----------------------------------------------------------------- occupancy

  async occupancy(req: any, from?: string, to?: string) {
    const { property, start, end, nights } = await this.range(req, from, to);
    const rooms = await this.activeRooms(property.id);
    const roomIds = rooms.map((r) => r.id);

    const inventory = roomIds.length
      ? await db.orm.public.RoomNightInventory.where((m) => m.roomId.in(roomIds)).all()
      : [];

    const nightSet = new Set(nights);
    const relevant = inventory.filter((n) => nightSet.has(String(n.stayDate).slice(0, 10)));

    // One available room-night per active room per night in range. A claimed row
    // is a sold room-night; the difference is what could have been sold.
    const availableRoomNights = rooms.length * nights.length;
    const soldRoomNights = relevant.length;

    // Reservations overlapping the range, used to reconcile the two sources.
    const reservations = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id) })
      .all();
    const reservationLines = reservations.length
      ? await db.orm.public.ReservationRoom
          .where((m) => m.reservationId.in(reservations.map((r) => r.id)))
          .all()
      : [];
    const overlappingReservations = reservations.filter(
      (r) =>
        ['CONFIRMED', 'CHECKED_IN'].includes(r.status) &&
        String(r.checkOutDate).slice(0, 10) > start &&
        String(r.checkInDate).slice(0, 10) <= end,
    );
    const expectedRoomNights = overlappingReservations.reduce((acc, r) => {
      const from_ = String(r.checkInDate).slice(0, 10) < start ? start : String(r.checkInDate).slice(0, 10);
      const to_ = String(r.checkOutDate).slice(0, 10) > end ? end : String(r.checkOutDate).slice(0, 10);
      return acc + enumerateNights(from_ as DateOnly, to_ as DateOnly).length;
    }, 0);

    return {
      from: start,
      to: end,
      nights: nights.length,
      rooms: rooms.length,
      availableRoomNights,
      soldRoomNights,
      unsoldRoomNights: availableRoomNights - soldRoomNights,
      occupancyPct: availableRoomNights === 0
        ? '0.00'
        : ((soldRoomNights / availableRoomNights) * 100).toFixed(2),
      // Reservations without a room do not claim nights, so this can legitimately
      // exceed the claimed figure; it is reported rather than reconciled away.
      reconciliation: {
        overlappingReservations: overlappingReservations.length,
        reservationRoomLines: reservationLines.length,
        expectedRoomNights,
        claimedRoomNights: soldRoomNights,
        matches: expectedRoomNights === soldRoomNights,
      },
    };
  }

  // ------------------------------------------------------------------- revenue

  /**
   * Financial rates. Requires `report.read.financial` at the controller.
   *
   * Payments collected are taken from settled payments net of refunds, which is
   * the cash actually in hand, and is a different number from billed revenue —
   * a stay can be billed and unpaid.
   */
  async revenue(req: any, from?: string, to?: string) {
    const { property, start, end } = await this.range(req, from, to);

    const folios = await db.orm.public.Folio.where({ propertyId: brand(property.id) }).all();

    const closedOrOpen = folios.filter((f) => {
      // The business date comes from the property's timezone, not from slicing
      // the raw timestamp: in UTC that slice is a day behind for any property
      // east of the server, which silently drops today's folios from revenue.
      const opened = businessDateOf(property.timezone, f.openedAt);
      return opened >= start && opened <= end;
    });

    let roomRevenueMinor = 0;
    let otherRevenueMinor = 0;
    let taxMinor = 0;

    if (closedOrOpen.length > 0) {
      const items = await db.orm.public.FolioItem
        .where((m) => m.folioId.in(closedOrOpen.map((f) => f.id)))
        .all();

      for (const i of items) {
        if (i.isVoided) continue;
        taxMinor += fromDecimal(String(i.taxAmount ?? 0)).minor;
        const amount = fromDecimal(String(i.totalAmount)).minor;
        if (i.type === 'ROOM_CHARGE') roomRevenueMinor += amount;
        else otherRevenueMinor += amount;
      }
    }

    const payments = closedOrOpen.length
      ? await db.orm.public.Payment.where((m) => m.folioId.in(closedOrOpen.map((f) => f.id))).all()
      : [];

    let collectedMinor = 0;
    let refundedMinor = 0;
    for (const p of payments) {
      if (p.status === 'PENDING' || p.status === 'FAILED') continue;
      collectedMinor += fromDecimal(String(p.amount)).minor;
      refundedMinor += p.refundedAmount ? fromDecimal(String(p.refundedAmount)).minor : 0;
    }
    const netCollectedMinor = collectedMinor - refundedMinor;

    const rooms = await this.activeRooms(property.id);
    const nights = enumerateNights(start, addDays(end, 1) as DateOnly);
    const availableRoomNights = rooms.length * nights.length;

    const inventory = rooms.length
      ? await db.orm.public.RoomNightInventory.where((m) => m.roomId.in(rooms.map((r) => r.id))).all()
      : [];
    const nightSet = new Set(nights);
    const soldRoomNights = inventory.filter((n) => nightSet.has(String(n.stayDate).slice(0, 10))).length;

    // Rates are money spread over a room count. The division goes through the
    // money module so it rounds half-up on a whole minor unit rather than
    // producing a float artefact like 4123.999999999999.
    const rate = (numeratorMinor: number, denominator: number) =>
      denominator === 0 ? '0.00' : toDecimal(divide({ minor: numeratorMinor }, denominator));

    return {
      from: start,
      to: end,
      nights: nights.length,
      currencyCode: property.currencyCode,
      roomRevenue: toDecimal({ minor: roomRevenueMinor }),
      otherRevenue: toDecimal({ minor: otherRevenueMinor }),
      taxTotal: toDecimal({ minor: taxMinor }),
      grossRevenue: toDecimal({ minor: roomRevenueMinor + otherRevenueMinor + taxMinor }),
      paymentsCollected: toDecimal({ minor: collectedMinor }),
      paymentsRefunded: toDecimal({ minor: refundedMinor }),
      paymentsNetCollected: toDecimal({ minor: netCollectedMinor }),
      soldRoomNights,
      availableRoomNights,
      adr: rate(roomRevenueMinor, soldRoomNights),
      revpar: rate(roomRevenueMinor, availableRoomNights),
      foliosConsidered: closedOrOpen.length,
      folioNos: closedOrOpen.slice(0, 20).map((f) => f.folioNo),
    };
  }

  // --------------------------------------------------------- arrivals/departures

  async arrivalsDepartures(req: any, from?: string, to?: string) {
    const { property, start, end } = await this.range(req, from, to);
    const canSeePii = this.canSeePii(req);

    const reservations = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id) })
      .all();

    const inRange = reservations.filter((r) => {
      const ci = String(r.checkInDate).slice(0, 10);
      const co = String(r.checkOutDate).slice(0, 10);
      return ci <= end && co >= start && r.status !== 'CANCELLED';
    });

    const guests = await this.guestsById([...new Set(inRange.map((r) => r.primaryGuestId))]);

    const lines = inRange.length
      ? await db.orm.public.ReservationRoom
          .where((m) => m.reservationId.in(inRange.map((r) => r.id)))
          .all()
      : [];
    const roomIds = [...new Set(lines.map((l) => l.roomId).filter(Boolean))] as string[];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const folios = inRange.length
      ? await db.orm.public.Folio.where((m) => m.reservationId.in(inRange.map((r) => r.id))).all()
      : [];
    const folioByRes = new Map(folios.map((f) => [f.reservationId, f]));

    return {
      from: start,
      to: end,
      currencyCode: property.currencyCode,
      rows: inRange
        .map((r) => {
          const line = lines.find((l) => l.reservationId === r.id);
          const room = line?.roomId ? roomById.get(line.roomId) : undefined;
          const folio = folioByRes.get(r.id);
          return {
            bookingCode: r.bookingCode,
            guestName: this.name(guests.get(r.primaryGuestId), canSeePii),
            status: r.status,
            checkInDate: String(r.checkInDate).slice(0, 10),
            checkOutDate: String(r.checkOutDate).slice(0, 10),
            nights: enumerateNights(
              String(r.checkInDate).slice(0, 10) as DateOnly,
              String(r.checkOutDate).slice(0, 10) as DateOnly,
            ).length,
            roomNumber: room?.roomNumber ?? null,
            nightlyRate: line ? String(line.nightlyRate) : null,
            folioNo: folio?.folioNo ?? null,
            folioStatus: folio?.status ?? null,
            adults: r.adults,
            children: r.children,
          };
        })
        .sort((a, b) => a.checkInDate.localeCompare(b.checkInDate) || a.bookingCode.localeCompare(b.bookingCode)),
    };
  }

  // ---------------------------------------------------------------- housekeeping

  /**
   * Housekeeping throughput and turnaround.
   *
   * Turnaround is measured from task creation to completion, which is the
   * interval a supervisor can actually influence.
   */
  async housekeeping(req: any, from?: string, to?: string) {
    const { property, start, end } = await this.range(req, from, to);

    const tasks = await db.orm.public.HousekeepingTask
      .where({ propertyId: brand(property.id) })
      .all();

    const inRange = tasks.filter((t) => {
      const d = businessDateOf(property.timezone, t.dueAt ?? t.createdAt);
      return d >= start && d <= end;
    });

    const rooms = await this.activeRooms(property.id);
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const completed = inRange.filter((t) => t.completedAt);
    const durations = completed
      .filter((t) => t.completedAt && t.createdAt)
      .map((t) =>
        (parseTimestamp(t.completedAt).getTime() - parseTimestamp(t.createdAt).getTime()) / 3_600_000,
      );

    const byType: Record<string, { total: number; completed: number; blocked: number }> = {};
    for (const t of inRange) {
      const key = t.type;
      byType[key] = byType[key] ?? { total: 0, completed: 0, blocked: 0 };
      byType[key].total += 1;
      if (t.completedAt) byType[key].completed += 1;
      if (t.status === 'BLOCKED') byType[key].blocked += 1;
    }

    const roomsTouched = new Set(inRange.map((t) => t.roomId));

    return {
      from: start,
      to: end,
      totalTasks: inRange.length,
      completed: completed.length,
      blocked: inRange.filter((t) => t.status === 'BLOCKED').length,
      inspected: inRange.filter((t) => t.inspectedAt).length,
      failedInspections: inRange.filter((t) => t.blockedReason && !t.completedAt).length,
      completionRate: inRange.length === 0
        ? '0.00'
        : ((completed.length / inRange.length) * 100).toFixed(2),
      avgTurnaroundHours: durations.length === 0
        ? '0.00'
        : (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2),
      roomsTouched: roomsTouched.size,
      roomsTotal: rooms.length,
      byType: Object.entries(byType).map(([type, v]) => ({ type, ...v })),
      blockedTasks: inRange
        .filter((t) => t.status === 'BLOCKED')
        .map((t) => ({
          id: t.id,
          roomNumber: roomById.get(t.roomId)?.roomNumber ?? null,
          reason: t.blockedReason,
          since: String(t.createdAt),
        })),
    };
  }
}