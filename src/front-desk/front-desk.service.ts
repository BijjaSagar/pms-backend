import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand, now, ts } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { FolioService } from '../folios/folio.service.js';
import { fromDecimal } from '../common/money.js';
import {
  addDays,
  businessDateFor,
  diffDays,
  enumerateNights,
  type DateOnly,
} from '../common/dates.js';

const ROOM_NIGHT_UNIQUE = 'RoomNightInventory_roomId_stayDate_key';

/** Room states a guest may legitimately be admitted to. */
const CHECKIN_READY = new Set(['VACANT_CLEAN', 'INSPECTED', 'OCCUPIED_CLEAN']);

  @Injectable()
export class FrontDeskService {
  constructor(
    private readonly folios: FolioService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Posts one room charge per night, keyed by reservation and night index.
   *
   * Posting incrementally rather than as a single lump at checkout is what makes
   * the folio useful during a stay: the guest can see what they owe and settle
   * it before leaving. It also preserves the "bill only for nights stayed"
   * rule, because nights beyond those actually occupied are never posted.
   *
   * The idempotency key makes topping up at checkout safe, so night 1 is never
   * charged twice.
   */
  private async postRoomNights(
    folioId: string,
    reservationId: string,
    nightlyRate: string,
    upToNight: number,
    actorId: string,
  ): Promise<void> {
    for (let n = 1; n <= upToNight; n++) {
      await this.folios.postCharge(folioId, {
        type: 'ROOM_CHARGE',
        description: `Room charge, night ${n}`,
        quantity: 1,
        unitAmount: nightlyRate,
        postedById: actorId,
        idempotencyKey: `room-charge:${reservationId}:n${n}`,
      });
    }
  }

  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    const p = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!p) throw new BadRequestException('Active property not found');
    return p;
  }

  // ---------------------------------------------------------------- check-in

  /**
   * Admits a guest.
   *
   * Idempotent by design: if the reservation is already checked in the current
   * state is returned unchanged rather than opening a second folio. Callers can
   * therefore retry safely after a dropped connection.
   */
  async checkIn(req: any, reservationId: string, opts: { overrideReason?: string }) {
    const property = await this.property(req);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');

    if (reservation.status === 'CHECKED_IN') {
      const folio = await db.orm.public.Folio
        .where({ reservationId: brand(reservation.id) })
        .first();
      return { idempotent: true, status: 'CHECKED_IN', folioId: folio?.id ?? null };
    }
    if (reservation.status !== 'CONFIRMED') {
      throw new ConflictException(
        `Cannot check in a ${reservation.status} reservation; only CONFIRMED reservations can be admitted`,
      );
    }

    // A stay cannot begin before it is booked to begin. Without this a booking
    // dated months ahead can be admitted, which opens a folio, posts a night,
    // and occupies a room for a night the guest is not here for.
    const businessDate = businessDateFor(property.timezone);
    const arrivalDate = String(reservation.checkInDate).slice(0, 10);
    if (diffDays(arrivalDate, businessDate) > 0) {
      throw new ConflictException(
        `This stay is not due to arrive until ${arrivalDate}, and the property business date is ${businessDate}.`,
      );
    }

    const lines = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservationId) })
      .all();
    if (lines.length === 0) throw new BadRequestException('Reservation has no room line');
    const line = lines[0];
    if (!line.roomId) {
      throw new BadRequestException('Assign a physical room before checking the guest in');
    }

    const room = await db.orm.public.Room.where({ id: brand(line.roomId) }).first();
    if (!room) throw new NotFoundException('Assigned room not found');
    if (room.status === 'OUT_OF_ORDER') {
      throw new ConflictException('The assigned room is out of order');
    }

    // A dirty room means housekeeping has not prepared it. That is a real
    // operational problem, so it is overridable but only with a recorded reason.
    if (!CHECKIN_READY.has(room.status) && !opts.overrideReason?.trim()) {
      throw new ConflictException(
        `Room ${room.roomNumber} is ${room.status} and not ready for check-in. A manager may override with a reason.`,
      );
    }

    const folio = await this.folios.openFolio(property.id, reservation.id, property.currencyCode);

    // The first night is charged on arrival so the folio shows a real balance
    // while the guest is in house, rather than appearing free until departure.
    await this.postRoomNights(folio.id, reservation.id, String(line.nightlyRate), 1, req.user.id);

    return db.transaction(async (tx: any) => {
      await tx.orm.public.Reservation.where({ id: brand(reservation.id) }).update({
        status: brand('CHECKED_IN'),
        checkedInAt: now(),
      });
      await tx.orm.public.Room.where({ id: brand(room.id) }).update({ status: brand('OCCUPIED_CLEAN') });

      await this.audit.record(
        {
          organizationId: req.user.organizationId,
          propertyId: property.id,
          actorUserId: req.user.id,
          action: 'stay.check_in',
          resourceType: 'Reservation',
          resourceId: reservation.id,
          reason: opts.overrideReason?.trim() ?? null,
          outcome: 'SUCCESS',
          metadata: { roomId: room.id, roomStatusBefore: room.status, folioId: folio.id },
        },
        tx,
      );

      return {
        idempotent: false,
        status: 'CHECKED_IN',
        folioId: folio.id,
        folioNo: folio.folioNo,
        roomNumber: room.roomNumber,
        checkedInAt: new Date().toISOString(),
      };
    });
  }

  // --------------------------------------------------------------- check-out

  /**
   * Settles and closes a stay.
   *
   * Posts the room charge for nights actually stayed, at the snapshot rate, so a
   * guest who departs early is not billed for nights they did not use. Posting
   * is idempotency-keyed, so a retried checkout cannot double-charge.
   */
  async checkOut(req: any, reservationId: string, opts: { overrideReason?: string }) {
    const property = await this.property(req);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');

    if (reservation.status === 'CHECKED_OUT') {
      return { idempotent: true, status: 'CHECKED_OUT' };
    }
    if (reservation.status !== 'CHECKED_IN') {
      throw new ConflictException(
        `Cannot check out a ${reservation.status} reservation; the guest must be checked in first`,
      );
    }

    const folio = await db.orm.public.Folio
      .where({ reservationId: brand(reservation.id) })
      .first();
    if (!folio) throw new ConflictException('No folio is open for this stay');

    const lines = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservation.id) })
      .all();
    const line = lines[0];
    if (!line) throw new BadRequestException('Reservation has no room line');

    // Nights actually consumed, never more than the booking allowed.
    const today = businessDateFor(property.timezone);
    const checkInDate = String(reservation.checkInDate);
    const checkOutDate = String(reservation.checkOutDate);
    const plannedNights = Math.max(0, diffDays(checkInDate, checkOutDate));

    // Billing runs to the end of today, because tonight's room is occupied even
    // when the guest leaves today. Counting only whole elapsed days would bill a
    // same-day stay as zero nights, which is wrong: the room was sold.
    //
    // The bill ends at whichever comes first: the end of today, or the date the
    // guest was due to leave. A guest departing early is therefore not billed
    // for nights they never used.
    const tonight = addDays(today, 1);
    const billThrough = diffDays(tonight, checkOutDate) >= 0 ? tonight : checkOutDate;
    const stayedNights = Math.min(
      plannedNights,
      Math.max(0, diffDays(checkInDate, billThrough)),
    );

    if (stayedNights > 0) {
      // Top up to the nights actually occupied. Nights already charged on
      // arrival are matched by idempotency key and are not charged twice.
      await this.postRoomNights(
        folio.id,
        reservation.id,
        String(line.nightlyRate),
        stayedNights,
        req.user.id,
      );
    }

    const balance = await this.folios.balance(folio.id);
    const owing = fromDecimal(balance.balance).minor;

    if (owing > 0) {
      const reason = opts.overrideReason?.trim();
      if (!reason) {
        throw new ConflictException(
          `Outstanding balance of ${balance.balance} ${balance.currencyCode}. Settle it, or a manager may check the guest out with a reason.`,
        );
      }
      // Waiving money is an override, so it needs its own permission on top of
      // `stay.check-out`. Front Desk holds the latter but not this one, which is
      // what keeps the escape hatch with Manager and Admin.
      if (!(req.user?.permissions ?? []).includes('folio.item.adjust')) {
        throw new ForbiddenException(
          'You do not have permission to waive an outstanding balance.',
        );
      }
    }

    const room = line.roomId
      ? await db.orm.public.Room.where({ id: brand(line.roomId) }).first()
      : null;

    return db.transaction(async (tx: any) => {
      await tx.orm.public.Folio.where({ id: brand(folio.id) }).update({
        status: brand('CLOSED'),
        closedAt: now(),
      });
      await tx.orm.public.Reservation.where({ id: brand(reservation.id) }).update({
        status: brand('CHECKED_OUT'),
        checkedOutAt: now(),
      });

      // Checkout leaves the room dirty; housekeeping owns what happens next.
      if (room) {
        await tx.orm.public.Room.where({ id: brand(room.id) }).update({ status: brand('VACANT_DIRTY') });
        const existing = await tx.orm.public.HousekeepingTask
          .where({ roomId: brand(room.id), type: brand('CHECKOUT_CLEAN'), status: brand('TODO') })
          .first();
        if (!existing) {
          await tx.orm.public.HousekeepingTask.create({
            propertyId: brand(property.id),
            roomId: brand(room.id),
            type: brand('CHECKOUT_CLEAN'),
            priority: brand('NORMAL'),
            status: brand('TODO'),
            dueAt: ts(new Date()),
            notes: brand(`Turnover clean after ${reservation.bookingCode}`),
          });
        }
      }

      await this.audit.record(
        {
          organizationId: req.user.organizationId,
          propertyId: property.id,
          actorUserId: req.user.id,
          action: 'stay.check_out',
          resourceType: 'Reservation',
          resourceId: reservation.id,
          reason: owing > 0 ? opts.overrideReason?.trim() ?? null : null,
          outcome: 'SUCCESS',
          metadata: {
            nightsStayed: stayedNights,
            total: balance.total,
            paid: balance.paid,
            waived: owing > 0 ? balance.balance : '0.00',
          },
        },
        tx,
      );

      return {
        idempotent: false,
        status: 'CHECKED_OUT',
        folioId: folio.id,
        nightsStayed: stayedNights,
        total: balance.total,
        paid: balance.paid,
        balance: balance.balance,
        currencyCode: balance.currencyCode,
        overridden: owing > 0,
        roomNumber: room?.roomNumber ?? null,
      };
    });
  }

  // ------------------------------------------------------------------ extend

  /**
   * Extends a stay, claiming the extra nights through the same allocation path
   * as booking so a clash returns 409 rather than silently overwriting.
   */
  async extend(req: any, reservationId: string, newCheckOutDate: DateOnly) {
    const property = await this.property(req);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (reservation.status !== 'CHECKED_IN') {
      throw new ConflictException('Only a checked-in stay can be extended');
    }

    const currentOut = String(reservation.checkOutDate);
    if (diffDays(currentOut, newCheckOutDate) <= 0) {
      throw new BadRequestException('The new check-out date must be later than the current one');
    }

    const line = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservationId) })
      .first();
    if (!line) throw new BadRequestException('Reservation has no room line');
    if (!line.roomId) {
      throw new ConflictException('Cannot extend a stay with no room assigned');
    }

    const addedNights = enumerateNights(currentOut, newCheckOutDate);
    const room = await db.orm.public.Room.where({ id: brand(line.roomId) }).first();

    try {
      return await db.transaction(async (tx: any) => {
        for (const night of addedNights) {
          try {
            await tx.orm.public.RoomNightInventory.create({
              roomId: brand(line.roomId!),
              reservationRoomId: brand(line.id),
              stayDate: brand(night),
              createdAt: ts(new Date()),
            });
          } catch (e) {
            const msg = String((e as { message?: string })?.message ?? '');
            if (msg.includes(ROOM_NIGHT_UNIQUE) || /duplicate key/i.test(msg)) {
              throw new ConflictException(
                'The room is not available for the extra nights; choose another room or shorten the stay.',
              );
            }
            throw e;
          }
        }
        await tx.orm.public.Reservation.where({ id: brand(reservation.id) }).update({
          checkOutDate: brand(newCheckOutDate),
        });
        await this.audit.record(
          {
            organizationId: req.user.organizationId,
            propertyId: property.id,
            actorUserId: req.user.id,
            action: 'stay.extend',
            resourceType: 'Reservation',
            resourceId: reservation.id,
            outcome: 'SUCCESS',
            metadata: { previousCheckOut: currentOut, newCheckOut: newCheckOutDate, addedNights: addedNights.length },
          },
          tx,
        );
        return {
          id: reservation.id,
          previousCheckOut: currentOut,
          checkOutDate: newCheckOutDate,
          addedNights: addedNights.length,
          roomNumber: room?.roomNumber ?? null,
        };
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }
  }

  // ------------------------------------------------------------------- reads

  private async decorate(rows: any[]) {
    if (rows.length === 0) return [];
    const guestIds = [...new Set(rows.map((r) => r.primaryGuestId))];
    const guests = guestIds.length
      ? await db.orm.public.Guest.where((m) => m.id.in(guestIds)).all()
      : [];
    const guestById = new Map(guests.map((g) => [g.id, g]));

    const lines = rows.length
      ? await db.orm.public.ReservationRoom
          .where((m) => m.reservationId.in(rows.map((r) => r.id)))
          .all()
      : [];
    const roomIds = [...new Set(lines.map((l) => l.roomId).filter(Boolean))] as string[];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const lineByRes = new Map(lines.map((l) => [l.reservationId, l]));

    // The folio is surfaced on the row because the front desk acts on money:
    // taking a payment and reading a balance both address the folio, not the
    // reservation. Without it the client would have to guess which id to post
    // against, and guessing wrong charges the wrong guest.
    const folios = rows.length
      ? await db.orm.public.Folio
          .where((m) => m.reservationId.in(rows.map((r) => r.id)))
          .all()
      : [];
    const folioByRes = new Map(folios.map((f) => [f.reservationId, f]));

    return rows.map((r) => {
      const l = lineByRes.get(r.id);
      const room = l?.roomId ? roomById.get(l.roomId) : undefined;
      const guest = guestById.get(r.primaryGuestId);
      const folio = folioByRes.get(r.id);
      return {
        id: r.id,
        bookingCode: r.bookingCode,
        status: r.status,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
        adults: r.adults,
        children: r.children,
        currencyCode: r.currencyCode,
        guestName: guest ? `${guest.firstName} ${guest.lastName}` : null,
        roomNumber: room?.roomNumber ?? null,
        roomStatus: room?.status ?? null,
        roomReady: room ? CHECKIN_READY.has(room.status) : false,
        folioId: folio?.id ?? null,
        folioNo: folio?.folioNo ?? null,
      };
    });
  }

  /** Guests expected to arrive, keyed on the property's business date. */
  async arrivals(req: any) {
    const property = await this.property(req);
    const today = businessDateFor(property.timezone);
    const rows = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id), status: brand('CONFIRMED') })
      .all();
    return {
      businessDate: today,
      data: await this.decorate(rows.filter((r) => String(r.checkInDate) <= today)),
    };
  }

  /** Guests due to depart today. */
  async departures(req: any) {
    const property = await this.property(req);
    const today = businessDateFor(property.timezone);
    const rows = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id), status: brand('CHECKED_IN') })
      .all();
    const due = rows.filter((r) => String(r.checkOutDate) <= today);
    const decorated = await this.decorate(due);

    // Balances require the folio, so they are attached after decoration.
    const withBalance = [];
    for (const r of decorated) {
      const folio = await db.orm.public.Folio.where({ reservationId: brand(r.id) }).first();
      const balance = folio ? await this.folios.balance(folio.id) : null;
      withBalance.push({ ...r, balance: balance?.balance ?? '0.00' });
    }
    return { businessDate: today, data: withBalance };
  }

  /** Guests currently in house. */
  async inHouse(req: any) {
    const property = await this.property(req);
    const rows = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id), status: brand('CHECKED_IN') })
      .all();
    return { businessDate: businessDateFor(property.timezone), data: await this.decorate(rows) };
  }
}