import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, now, ts } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { FolioService } from './folio.service.js';
import {
  InvalidStayError,
  businessDateFor,
  enumerateNights,
  nightCount,
  validateStay,
  type DateOnly,
} from '../common/dates.js';
import { fromDecimal, toDecimal, computeTotals, type Money } from '../common/money.js';
import { activeTaxRules, estimateStay } from '../common/tax-rules.js';
import type { ActorContext } from '../contracts/shared.js';
import type { CreateReservationInput, ReservationListOptions } from '../contracts/booking.messages.js';
import { RoomHoldService } from './room-hold.service.js';
import { isUniqueViolation, UNIQUE } from '../common/db-errors.js';

const ROOM_NIGHT_UNIQUE = UNIQUE.ROOM_NIGHT;
const BOOKING_CODE_UNIQUE = UNIQUE.BOOKING_CODE;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly audit: AuditService,
    private readonly holds: RoomHoldService,
    private readonly folios: FolioService,
  ) {}

  private async activeProperty(actor: ActorContext): Promise<any> {
    const propertyId = actor.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    const property = await db.orm.public.Property.where({ id: brand(propertyId) }).first();
    if (!property) throw new BadRequestException('Active property not found');
    return property;
  }

  /** Booking codes are unique per property; a collision retries with a new suffix. */
  private newBookingCode(): string {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const suffix = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return `RSV-${stamp}-${suffix}`;
  }

  /**
   * Rooms of a type that are free for every night of the requested range.
   *
   * This is a preview for the UI only. The authoritative check is the unique
   * constraint applied during the save transaction, because a preview result
   * can always be stale by the time the user submits. Rooms currently held by
   * *another* user are excluded so the picker reflects a room someone else is
   * already booking; the caller's own holds remain selectable.
   */
  async availability(actor: ActorContext, roomTypeId: string, checkIn: DateOnly, checkOut: DateOnly) {
    const propertyId = actor.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    validateStay(checkIn, checkOut);
    const nights = enumerateNights(checkIn, checkOut);

    const rooms = await db.orm.public.Room
      .where({ propertyId: brand(propertyId), roomTypeId: brand(roomTypeId), isActive: brand(true) })
      .all();

    const usable = rooms.filter((r) => r.status !== 'OUT_OF_ORDER');
    if (usable.length === 0) return { nights, available: [], totalRooms: 0 };

    const unavailable = await this.holds.unavailableRooms(usable.map((r) => r.id), nights, actor.id);

    return {
      nights,
      totalRooms: usable.length,
      available: usable
        .filter((r) => !unavailable.has(r.id))
        .map((r) => ({
          id: r.id,
          roomNumber: r.roomNumber,
          floor: r.floor,
          status: r.status,
        })),
    };
  }

  /**
   * Creates a reservation with its rate snapshot.
   *
   * Room-night allocation happens inside this same transaction, so a reservation
   * can never exist without its allocations, and a lost allocation race rolls
   * the whole reservation back rather than leaving an orphaned booking.
   *
   * A `holdId` from the selection step is consumed on success; a room held by
   * another user is refused up front so a direct call cannot jump the queue.
   */
  async create(actor: ActorContext, input: CreateReservationInput) {
    const property = await this.activeProperty(actor);
    try {
      validateStay(input.checkInDate as DateOnly, input.checkOutDate as DateOnly);
    } catch (e) {
      if (e instanceof InvalidStayError) throw new BadRequestException(e.message);
      throw e;
    }

    // A physical room is required: a booking with no room writes no inventory
    // and could oversell the room type.
    if (!input.roomId) {
      throw new BadRequestException('Select a room before confirming the booking');
    }
    // The selection-time hold is the credential that reserves the nights.
    if (!input.holdId) {
      throw new BadRequestException('Select the room to hold it before confirming the booking');
    }

    // Idempotency: a replayed request returns the booking it already created.
    if (input.idempotencyKey) {
      const existing = await db.orm.public.Reservation
        .where({ idempotencyKey: brand(input.idempotencyKey) })
        .first();
      if (existing) return this.shapeReservation(existing, true);
    }

    const guest = await db.orm.public.Guest
      .where({ id: brand(input.primaryGuestId), organizationId: brand(actor.organizationId) })
      .first();
    if (!guest) throw new NotFoundException('Guest not found');

    const roomType = await db.orm.public.RoomType
      .where({ id: brand(input.roomTypeId), propertyId: brand(property.id) })
      .first();
    if (!roomType) throw new NotFoundException('Room type not found in this property');

    if (input.roomId) {
      const room = await db.orm.public.Room
        .where({ id: brand(input.roomId), propertyId: brand(property.id) })
        .first();
      if (!room) throw new NotFoundException('Room not found in this property');
      if (room.roomTypeId !== roomType.id) {
        throw new BadRequestException('Room does not belong to the selected room type');
      }
      if (room.status === 'OUT_OF_ORDER') {
        throw new ConflictException('That room is out of order and cannot be assigned');
      }
    }

    const nights = enumerateNights(input.checkInDate as DateOnly, input.checkOutDate as DateOnly);

    // A room another user is holding or has booked is refused before the write,
    // so the second user gets a clear message rather than losing a race.
    const unavailable = await this.holds.unavailableRooms([input.roomId], nights, actor.id);
    if (unavailable.has(input.roomId)) {
      throw new ConflictException(
        'That room is no longer available for these nights. Choose another room.',
      );
    }

    // RatePlan rows exist for future plan-based pricing, but the booking flow
    // does not select a plan yet, so the nightly rate comes from the room
    // type's base rate. The snapshot is written now so a later rate change
    // cannot rewrite what this booking agreed to.
    //
    // The rate goes through the money module rather than raw float arithmetic:
    // 0.1 * 3 is 0.30000000000000004 in binary floating point, and that error
    // becomes a guest folio that does not reconcile.
    const nightlyRate = fromDecimal(String(roomType.baseRate));

    // Validate & normalise the extras payload.
    const extras = (input.extras ?? []).filter((e: any) => e && typeof e.name === 'string');
    const extraBaseMinor = extras.reduce((acc, e: any) => {
      const qty = Math.max(1, Math.floor(Number(e.quantity) || 1));
      let unit: Money;
      try { unit = fromDecimal(String(e.unitRate)); } catch { throw new BadRequestException('unitRate must be a decimal amount'); }
      return acc + unit.minor * qty;
    }, 0);
    const roomBaseMinor = nightlyRate.minor * nights.length;
    const grossBaseMinor = roomBaseMinor + extraBaseMinor;
    const discountMinor = input.discount ? fromDecimal(String(input.discount)).minor : 0;
    const appliedDiscountMinor = Math.min(Math.max(0, discountMinor), grossBaseMinor);
    // Tax: room uses ROOM/ALL rules; extras use INCIDENTAL/ALL rules. Total per
    // line to avoid double-counting ALL across kinds.
    const roomTaxRules = await activeTaxRules(property.id, { appliesTo: ['ROOM', 'ALL'], stayDate: input.checkInDate as DateOnly });
    const incidentalTaxRules = await activeTaxRules(property.id, { appliesTo: ['INCIDENTAL', 'ALL'], stayDate: input.checkInDate as DateOnly });
    const roomTaxMinor = computeTotals([{ amount: { minor: roomBaseMinor }, taxable: true }], roomTaxRules).taxTotal.minor;
    const extraTaxMinor = extras.reduce((acc, e: any) => {
      const qty = Math.max(1, Math.floor(Number(e.quantity) || 1));
      const unit = fromDecimal(String(e.unitRate));
      const line = unit.minor * qty;
      return acc + (e.taxable === false ? 0 : computeTotals([{ amount: { minor: line }, taxable: true }], incidentalTaxRules).taxTotal.minor);
    }, 0);
    const appliedTaxMinor = roomTaxMinor + extraTaxMinor;
    const subtotalMinor = grossBaseMinor - appliedDiscountMinor;
    const totalMinor = subtotalMinor + appliedTaxMinor;
    const subtotal = toDecimal({ minor: subtotalMinor });
    const taxTotal = toDecimal({ minor: appliedTaxMinor });
    const total = toDecimal({ minor: totalMinor });

    const created = await db.transaction(async (tx: any) => {
      let reservation = null;
      for (let attempt = 0; attempt < 5 && !reservation; attempt++) {
        try {
          reservation = await tx.orm.public.Reservation.create({
            propertyId: brand(property.id),
            bookingCode: brand(this.newBookingCode()),
            status: brand('CONFIRMED'),
            source: brand(input.source ?? 'DIRECT'),
            primaryGuestId: brand(input.primaryGuestId),
            createdById: brand(actor.id),
            checkInDate: brand(input.checkInDate),
            checkOutDate: brand(input.checkOutDate),
            adults: brand(input.adults),
            children: brand(input.children),
            currencyCode: brand(property.currencyCode),
            subtotal: brand(subtotal),
            taxTotal: brand(taxTotal),
            totalAmount: brand(total),
            specialRequests: brand(input.notes ?? null),
            idempotencyKey: brand(input.idempotencyKey ?? null),
          });
        } catch (e) {
          if (isUniqueViolation(e, BOOKING_CODE_UNIQUE)) continue;
          throw e;
        }
      }
      if (!reservation) throw new ConflictException('Could not allocate a booking code');

      const reservationRoom = await tx.orm.public.ReservationRoom.create({
        reservationId: brand(reservation.id),
        roomTypeId: brand(roomType.id),
        roomId: brand(input.roomId ?? null),
        adults: brand(input.adults),
        children: brand(input.children),
        nightlyRate: brand(toDecimal(nightlyRate)),
        ratePlanName: brand(null),
      });

      // Open a folio at booking time so the extras the guest agreed to are
      // recorded against the stay rather than left as frontend-only estimates.
      const d = new Date();
      const folioNo = `F-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(randomInt(0, 100_000)).padStart(5, '0')}`;
      const folio = await tx.orm.public.Folio.create({
        propertyId: brand(property.id),
        reservationId: brand(reservation.id),
        folioNo: brand(folioNo),
        status: brand('OPEN'),
        currencyCode: brand(property.currencyCode),
        openedAt: now(),
      });
      const createdItems: any[] = [];
      const roomLineQty = nights.length;
      let excess = 0;
      const roomItem = await tx.orm.public.FolioItem.create({
        folioId: brand(folio.id),
        type: brand('ROOM_CHARGE') as never,
        description: brand(`Room — ${roomType.name} × ${roomLineQty}n`),
        quantity: brand(String(roomLineQty)),
        unitAmount: brand(toDecimal(nightlyRate)),
        taxAmount: brand(toDecimal({ minor: roomTaxMinor })),
        taxSnapshot: brand(JSON.stringify(roomTaxRules)),
        totalAmount: brand(toDecimal({ minor: nightlyRate.minor * roomLineQty })),
        postedById: brand(actor.id),
        isVoided: brand(false),
      });
      createdItems.push(roomItem);

      for (const e of extras) {
        const qty = Math.max(1, Math.floor(Number(e.quantity) || 1));
        const unit = fromDecimal(String(e.unitRate));
        const lineMinor = unit.minor * qty;
        const lineTax = e.taxable === false ? 0 : computeTotals([{ amount: { minor: lineMinor }, taxable: true }], incidentalTaxRules).taxTotal.minor;
        createdItems.push(
          await tx.orm.public.FolioItem.create({
            folioId: brand(folio.id),
            type: brand('INCIDENTAL') as never,
            description: brand(e.name),
            quantity: brand(String(qty)),
            unitAmount: brand(toDecimal(unit)),
            taxAmount: brand(toDecimal({ minor: lineTax })),
            taxSnapshot: brand(JSON.stringify(incidentalTaxRules)),
            totalAmount: brand(toDecimal({ minor: lineMinor })),
            postedById: brand(actor.id),
            isVoided: brand(false),
          }),
        );
      }
      if (appliedDiscountMinor > 0) {
        await tx.orm.public.FolioItem.create({
          folioId: brand(folio.id),
          type: brand('DISCOUNT') as never,
          description: brand('Reservation discount'),
          quantity: brand('1'),
          unitAmount: brand(toDecimal({ minor: -appliedDiscountMinor })),
          taxAmount: brand('0.00'),
          totalAmount: brand(toDecimal({ minor: -appliedDiscountMinor })),
          postedById: brand(actor.id),
          isVoided: brand(false),
        });
      }

      // Convert the caller's live hold into permanent inventory inside this
      // transaction. This validates the hold (ownership, expiry, exact dates)
      // and claims the nights atomically — a stale token throws and rolls the
      // whole booking back.
      await this.holds.convert(tx, actor, input.holdId!, reservationRoom.id, nights);

      await this.audit.record(
        {
          organizationId: actor.organizationId,
          propertyId: property.id,
          actorUserId: actor.id,
          action: 'reservation.create',
          resourceType: 'Reservation',
          resourceId: reservation.id,
          outcome: 'SUCCESS',
          metadata: { bookingCode: reservation.bookingCode, nights: nights.length },
        },
        tx,
      );

      return {
        id: reservation.id,
        bookingCode: reservation.bookingCode,
        status: reservation.status,
        checkInDate: reservation.checkInDate,
        checkOutDate: reservation.checkOutDate,
        nights: nights.length,
        subtotal,
        taxTotal,
        totalAmount: total,
        currencyCode: reservation.currencyCode,
        roomAssigned: true,
        idempotent: false,
      };
    }).catch(async (e: unknown) => {
      // A concurrent duplicate carrying the same idempotency key: return the
      // booking the winner already created rather than a second reservation.
      if (input.idempotencyKey && isUniqueViolation(e, UNIQUE.IDEMPOTENCY_KEY)) {
        const existing = await db.orm.public.Reservation
          .where({ idempotencyKey: brand(input.idempotencyKey) })
          .first();
        if (existing) return this.shapeReservation(existing, true);
      }
      throw e;
    });

    // Announce the confirmed booking once the inventory rows are committed.
    if (!created.idempotent) {
      await this.holds.afterBooked(actor, input.roomId ?? null, nights);
    }
    return created;
  }

  /** Shapes a stored reservation for the create / idempotent-replay response. */
  private shapeReservation(reservation: any, idempotent = false) {
    return {
      id: reservation.id,
      bookingCode: reservation.bookingCode,
      status: reservation.status,
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      nights: nightCount(String(reservation.checkInDate), String(reservation.checkOutDate)),
      subtotal: String(reservation.subtotal),
      taxTotal: String(reservation.taxTotal),
      totalAmount: String(reservation.totalAmount),
      currencyCode: reservation.currencyCode,
      roomAssigned: true,
      idempotent,
    };
  }

  async assignRoom(actor: ActorContext, reservationId: string, roomId: string) {
    // The ValidationPipe can hand through a non-string when the body shape is
    // unexpected, and a coerced object reaches Postgres as "[object Object]".
    // Failing loudly here beats an opaque driver error.
    if (typeof roomId !== 'string' || !roomId) {
      throw new BadRequestException('roomId must be a non-empty string');
    }
    if (typeof reservationId !== 'string' || !reservationId) {
      throw new BadRequestException('reservation id must be a non-empty string');
    }

    const property = await this.activeProperty(actor);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (['CANCELLED', 'CHECKED_OUT'].includes(String(reservation.status))) {
      throw new ConflictException(`Cannot assign a room to a ${reservation.status} reservation`);
    }

    const room = await db.orm.public.Room
      .where({ id: brand(roomId), propertyId: brand(property.id) })
      .first();
    if (!room) throw new NotFoundException('Room not found in this property');
    if (room.status === 'OUT_OF_ORDER') {
      throw new ConflictException('That room is out of order and cannot be assigned');
    }

    const rr = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservationId) })
      .first();
    if (!rr) throw new NotFoundException('Reservation has no room line');
    if (room.roomTypeId !== rr.roomTypeId) {
      throw new BadRequestException('Room does not match the reserved room type');
    }

    const nights = enumerateNights(
      String(reservation.checkInDate),
      String(reservation.checkOutDate),
    );

    const unavailable = await this.holds.unavailableRooms([room.id], nights, actor.id);
    if (unavailable.has(room.id)) {
      throw new ConflictException(
        'That room is no longer available for these nights. Choose another room.',
      );
    }

    return db.transaction(async (tx: any) => {
      // Free any previous allocation before claiming the new room.
      await tx.orm.public.RoomNightInventory
        .where({ reservationRoomId: brand(rr.id) })
        .deleteAll();

      for (const night of nights) {
        try {
          await tx.orm.public.RoomNightInventory.create({
            roomId: brand(room.id),
            reservationRoomId: brand(rr.id),
            stayDate: brand(night),
            createdAt: ts(new Date()),
          });
        } catch (e) {
          if (isUniqueViolation(e, ROOM_NIGHT_UNIQUE)) {
            throw new ConflictException(
              'Room availability changed; refresh and choose another room.',
            );
          }
          throw e;
        }
      }

      await tx.orm.public.ReservationRoom
        .where({ id: brand(rr.id) })
        .update({ roomId: brand(room.id) });

      await this.audit.record(
        {
          organizationId: actor.organizationId,
          propertyId: property.id,
          actorUserId: actor.id,
          action: 'reservation.assign_room',
          resourceType: 'Reservation',
          resourceId: reservationId,
          outcome: 'SUCCESS',
          metadata: { roomId: room.id, nights: nights.length },
        },
        tx,
      );

      return { reservationId, roomId: room.id, roomNumber: room.roomNumber, nights: nights.length };
    });
  }

  /**
   * Amends dates or party size. Old nights are released and new ones claimed in
   * one transaction, and the stored estimate is recomputed at the reservation's
   * own snapshot rate.
   */
  async update(actor: ActorContext, reservationId: string, body: any) {
    const property = await this.activeProperty(actor);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');

    // Status is never settable through a generic patch; the kit requires
    // explicit, validated commands for state changes.
    if (body.status !== undefined) {
      throw new BadRequestException(
        'Status cannot be changed with PATCH. Use the explicit command endpoints.',
      );
    }
    if (['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'].includes(String(reservation.status))) {
      throw new ConflictException(`Cannot amend a ${reservation.status} reservation`);
    }

    const checkIn = (body.checkInDate ?? reservation.checkInDate) as DateOnly;
    const checkOut = (body.checkOutDate ?? reservation.checkOutDate) as DateOnly;
    try {
      validateStay(checkIn, checkOut);
    } catch (e) {
      if (e instanceof InvalidStayError) throw new BadRequestException(e.message);
      throw e;
    }

    const rr = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservationId) })
      .first();
    if (!rr) throw new NotFoundException('Reservation has no room line');

    const roomType = await db.orm.public.RoomType.where({ id: brand(rr.roomTypeId) }).first();
    const nights = enumerateNights(checkIn, checkOut);
    // The agreed nightly rate survives amendments and later base-rate edits;
    // only the night count changes here.
    const nightlyRate = fromDecimal(String(rr.nightlyRate ?? roomType?.baseRate ?? '0'));
    const estimate = estimateStay(nightlyRate, nights.length, await activeTaxRules(property.id));
    const subtotal = toDecimal(estimate.subtotal);
    const taxTotal = toDecimal(estimate.taxTotal);
    const total = toDecimal(estimate.grandTotal);

    const datesChanged = checkIn !== reservation.checkInDate || checkOut !== reservation.checkOutDate;

    return db.transaction(async (tx: any) => {
      if (datesChanged) {
        await tx.orm.public.RoomNightInventory
          .where({ reservationRoomId: brand(rr.id) })
          .deleteAll();

        if (rr.roomId) {
          for (const night of nights) {
            try {
              await tx.orm.public.RoomNightInventory.create({
                roomId: brand(rr.roomId!),
                reservationRoomId: brand(rr.id),
                stayDate: brand(night),
                createdAt: ts(new Date()),
              });
            } catch (e) {
              if (isUniqueViolation(e, ROOM_NIGHT_UNIQUE)) {
                throw new ConflictException(
                  'The amended dates clash with another booking for that room.',
                );
              }
              throw e;
            }
          }
        }
      }

      const patch: Record<string, never> = {
        checkInDate: brand(checkIn),
        checkOutDate: brand(checkOut),
        subtotal: brand(subtotal),
        taxTotal: brand(taxTotal),
        totalAmount: brand(total),
      };
      if (body.adults !== undefined) patch['adults'] = brand(body.adults);
      if (body.children !== undefined) patch['children'] = brand(body.children);
      if (body.specialRequests !== undefined) patch['specialRequests'] = brand(body.specialRequests);

      await tx.orm.public.Reservation.where({ id: brand(reservationId) }).update(patch);
      if (body.adults !== undefined || body.children !== undefined) {
        await tx.orm.public.ReservationRoom.where({ id: brand(rr.id) }).update({
          adults: brand(body.adults ?? rr.adults),
          children: brand(body.children ?? rr.children),
        });
      }

      await this.audit.record(
        {
          organizationId: actor.organizationId,
          propertyId: property.id,
          actorUserId: actor.id,
          action: 'reservation.update',
          resourceType: 'Reservation',
          resourceId: reservationId,
          outcome: 'SUCCESS',
          metadata: {
            datesChanged,
            previousCheckIn: reservation.checkInDate,
            previousCheckOut: reservation.checkOutDate,
          },
        },
        tx,
      );

      return {
        id: reservationId,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        nights: nights.length,
        subtotal,
        taxTotal,
        totalAmount: total,
        roomReallocated: datesChanged && !!rr.roomId,
      };
    });
  }

  /** Cancels a reservation. A reason is mandatory and always audited. */
  async cancel(actor: ActorContext, reservationId: string, reason: string) {
    const property = await this.activeProperty(actor);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (reservation.status === 'CANCELLED') return { id: reservationId, status: 'CANCELLED' };
    if (['CHECKED_IN', 'CHECKED_OUT'].includes(String(reservation.status))) {
      throw new ConflictException(`Cannot cancel a ${reservation.status} reservation`);
    }
    if (!reason?.trim()) throw new BadRequestException('A cancellation reason is required');

    const result = await db.transaction(async (tx: any) => {
      const rrs = await tx.orm.public.ReservationRoom
        .where({ reservationId: brand(reservationId) })
        .all();
      const freedNights: string[] = [];
      for (const rr of rrs) {
        const nights = await tx.orm.public.RoomNightInventory
          .where({ reservationRoomId: brand(rr.id) })
          .all();
        freedNights.push(...nights.map((n: any) => String(n.stayDate)));
        await tx.orm.public.RoomNightInventory
          .where({ reservationRoomId: brand(rr.id) })
          .deleteAll();
      }

      await tx.orm.public.Reservation.where({ id: brand(reservationId) }).update({
        status: brand('CANCELLED'),
        cancellationReason: brand(reason.trim()),
        cancelledAt: now(),
      });

      await this.audit.record(
        {
          organizationId: actor.organizationId,
          propertyId: property.id,
          actorUserId: actor.id,
          action: 'reservation.cancel',
          resourceType: 'Reservation',
          resourceId: reservationId,
          reason: reason.trim(),
          outcome: 'SUCCESS',
        },
        tx,
      );

      const roomId = (rrs[0]?.roomId as string | null) ?? null;
      return { id: reservationId, status: 'CANCELLED', releasedRoomLines: rrs.length, roomId, freedNights };
    });

    await this.holds.announceCancelled(actor, result.roomId, result.freedNights);
    return { id: result.id, status: result.status, releasedRoomLines: result.releasedRoomLines };
  }

  async detail(actor: ActorContext, reservationId: string) {
    const property = await this.activeProperty(actor);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');

    const guest = await db.orm.public.Guest.where({ id: brand(reservation.primaryGuestId) }).first();
    const lines = await db.orm.public.ReservationRoom
      .where({ reservationId: brand(reservationId) })
      .all();
    const roomIds = lines.map((l) => l.roomId).filter(Boolean) as string[];
    const rooms = roomIds.length
      ? await db.orm.public.Room.where((m) => m.id.in(roomIds)).all()
      : [];
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const nightRows = lines.length
      ? await db.orm.public.RoomNightInventory
          .where((m) => m.reservationRoomId.in(lines.map((l) => l.id)))
          .all()
      : [];

    return {
      id: reservation.id,
      bookingCode: reservation.bookingCode,
      status: reservation.status,
      source: reservation.source,
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      nights: nightCount(
        String(reservation.checkInDate),
        String(reservation.checkOutDate),
      ),
      adults: reservation.adults,
      children: reservation.children,
      currencyCode: reservation.currencyCode,
      subtotal: String(reservation.subtotal),
      taxTotal: String(reservation.taxTotal),
      totalAmount: String(reservation.totalAmount),
      specialRequests: reservation.specialRequests,
      cancellationReason: reservation.cancellationReason,
      createdAt: reservation.createdAt,
      guest: guest
        ? { id: guest.id, firstName: guest.firstName, lastName: guest.lastName }
        : null,
      roomLines: lines.map((l) => ({
        id: l.id,
        roomTypeId: l.roomTypeId,
        roomId: l.roomId,
        roomNumber: l.roomId ? roomById.get(l.roomId)?.roomNumber ?? null : null,
        nightlyRate: String(l.nightlyRate),
        allocatedNights: nightRows.filter((n) => n.reservationRoomId === l.id).length,
      })),
    };
  }

  async list(actor: ActorContext, opts: ReservationListOptions) {
    const property = await this.activeProperty(actor);
    const take = Math.min(Math.max(opts.pageSize, 1), 100);
    const skip = Math.max(opts.page, 1) - 1;

    const rows = await db.orm.public.Reservation
      .where({ propertyId: brand(property.id) })
      .orderBy((r) => r.createdAt.desc())
      .limit(take + 1)
      .offset(skip * take)
      .all();

    const filtered = rows.filter((r) => {
      if (opts.status && r.status !== opts.status) return false;
      if (opts.checkIn && String(r.checkOutDate) <= opts.checkIn) return false;
      if (opts.checkOut && String(r.checkInDate) >= opts.checkOut) return false;
      return true;
    });

    let items = filtered;
    if (opts.search) {
      const q = opts.search.toLowerCase();
      const guestIds = [
        ...new Set(filtered.map((r) => r.primaryGuestId)),
      ];
      const guests = guestIds.length
        ? await db.orm.public.Guest.where((m) => m.id.in(guestIds)).all()
        : [];
      const nameById = new Map(
        guests.map((g) => [g.id, `${g.firstName} ${g.lastName}`.toLowerCase()]),
      );
      items = filtered.filter(
        (r) =>
          String(r.bookingCode).toLowerCase().includes(q) ||
          nameById.get(r.primaryGuestId)?.includes(q) === true,
      );
    }

    const guestIds = [...new Set(items.map((r) => r.primaryGuestId))];
    const guests = guestIds.length
      ? await db.orm.public.Guest.where((m) => m.id.in(guestIds)).all()
      : [];
    const guestById = new Map(guests.map((g) => [g.id, g]));

    return {
      data: items.map((r) => ({
        id: r.id,
        bookingCode: r.bookingCode,
        status: r.status,
        source: r.source,
        checkInDate: r.checkInDate,
        checkOutDate: r.checkOutDate,
        nights: nightCount(String(r.checkInDate), String(r.checkOutDate)),
        totalAmount: String(r.totalAmount),
        currencyCode: r.currencyCode,
        guest: guestById.has(r.primaryGuestId)
          ? (() => {
              const g = guestById.get(r.primaryGuestId)!;
              return { id: g.id, name: `${g.firstName} ${g.lastName}` };
            })()
          : null,
      })),
      page: opts.page,
      pageSize: take,
      hasMore: rows.length > take,
      today: businessDateFor(property.timezone),
    };
  }
}
