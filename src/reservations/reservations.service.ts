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
import {
  InvalidStayError,
  businessDateFor,
  enumerateNights,
  nightCount,
  validateStay,
  type DateOnly,
} from '../common/dates.js';
import { fromDecimal, multiply, toDecimal } from '../common/money.js';

/** Postgres unique_violation. The constraint name tells us which guarantee fired. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return (
    e.code === '23505' && typeof e.message === 'string' && e.message.includes(constraint)
  );
}

const ROOM_NIGHT_UNIQUE = 'RoomNightInventory_roomId_stayDate_key';
const BOOKING_CODE_UNIQUE = 'Reservation_propertyId_bookingCode_key';

export interface CreateReservationInput {
  primaryGuestId: string;
  checkInDate: DateOnly;
  checkOutDate: DateOnly;
  adults: number;
  children: number;
  roomTypeId: string;
  roomId?: string | null;
  source?: string;
  notes?: string | null;
}

@Injectable()
export class ReservationsService {
  constructor(private readonly audit: AuditService) {}

  private async activeProperty(req: { user?: any }): Promise<any> {
    const propertyId = req.user?.activePropertyId;
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
   * can always be stale by the time the user submits.
   */
  async availability(propertyId: string, roomTypeId: string, checkIn: DateOnly, checkOut: DateOnly) {
    validateStay(checkIn, checkOut);
    const nights = enumerateNights(checkIn, checkOut);

    const rooms = await db.orm.public.Room
      .where({ propertyId: brand(propertyId), roomTypeId: brand(roomTypeId), isActive: brand(true) })
      .all();

    const usable = rooms.filter((r) => r.status !== 'OUT_OF_ORDER');
    if (usable.length === 0) return { nights, available: [], totalRooms: 0 };

    const taken = await db.orm.public.RoomNightInventory
      .where((m) => m.roomId.in(usable.map((r) => r.id)))
      .all();
    const takenByRoom = new Map<string, Set<string>>();
    for (const t of taken) {
      if (!takenByRoom.has(t.roomId)) takenByRoom.set(t.roomId, new Set());
      takenByRoom.get(t.roomId)!.add(String(t.stayDate));
    }

    return {
      nights,
      totalRooms: usable.length,
      available: usable
        .filter((r) => !nights.some((n) => takenByRoom.get(r.id)?.has(n)))
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
   */
  async create(req: any, input: CreateReservationInput) {
    const property = await this.activeProperty(req);
    try {
      validateStay(input.checkInDate, input.checkOutDate);
    } catch (e) {
      if (e instanceof InvalidStayError) throw new BadRequestException(e.message);
      throw e;
    }

    const guest = await db.orm.public.Guest
      .where({ id: brand(input.primaryGuestId), organizationId: brand(req.user.organizationId) })
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

    const nights = enumerateNights(input.checkInDate, input.checkOutDate);
    // No RatePlan rows are seeded yet, so the nightly rate comes from the room
    // type's base rate. The snapshot is written now so a later rate change
    // cannot rewrite what this booking agreed to.
    //
    // The rate goes through the money module rather than raw float arithmetic:
    // 0.1 * 3 is 0.30000000000000004 in binary floating point, and that error
    // becomes a guest folio that does not reconcile.
    const nightlyRate = fromDecimal(String(roomType.baseRate));
    const subtotal = multiply(nightlyRate, nights.length).minor / 100;

    try {
      return await db.transaction(async (tx: any) => {
        let reservation = null;
        for (let attempt = 0; attempt < 5 && !reservation; attempt++) {
          try {
            reservation = await tx.orm.public.Reservation.create({
              propertyId: brand(property.id),
              bookingCode: brand(this.newBookingCode()),
              status: brand('CONFIRMED'),
              source: brand(input.source ?? 'DIRECT'),
              primaryGuestId: brand(input.primaryGuestId),
              createdById: brand(req.user.id),
              checkInDate: brand(input.checkInDate),
              checkOutDate: brand(input.checkOutDate),
              adults: brand(input.adults),
              children: brand(input.children),
              currencyCode: brand(property.currencyCode),
              subtotal: brand(String(subtotal)),
              taxTotal: brand('0'),
              totalAmount: brand(String(subtotal)),
              specialRequests: brand(input.notes ?? null),
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

        if (input.roomId) {
          try {
            for (const night of nights) {
              await tx.orm.public.RoomNightInventory.create({
                roomId: brand(input.roomId),
                reservationRoomId: brand(reservationRoom.id),
                stayDate: brand(night),
                createdAt: ts(new Date()),
              });
            }
          } catch (e) {
            // The database is the authority on availability, not the preview.
            if (isUniqueViolation(e, ROOM_NIGHT_UNIQUE)) {
              throw new ConflictException(
                'Room availability changed; refresh and choose another room.',
              );
            }
            throw e;
          }
        }

        await this.audit.record(
          {
            organizationId: req.user.organizationId,
            propertyId: property.id,
            actorUserId: req.user.id,
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
          subtotal: String(subtotal),
          taxTotal: '0',
          totalAmount: String(subtotal),
          currencyCode: reservation.currencyCode,
          roomAssigned: !!input.roomId,
        };
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }
  }

  async assignRoom(req: any, reservationId: string, roomId: string) {
    // The ValidationPipe can hand through a non-string when the body shape is
    // unexpected, and a coerced object reaches Postgres as "[object Object]".
    // Failing loudly here beats an opaque driver error.
    if (typeof roomId !== 'string' || !roomId) {
      throw new BadRequestException('roomId must be a non-empty string');
    }
    if (typeof reservationId !== 'string' || !reservationId) {
      throw new BadRequestException('reservation id must be a non-empty string');
    }

    const property = await this.activeProperty(req);
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

    try {
      return await db.transaction(async (tx: any) => {
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
            organizationId: req.user.organizationId,
            propertyId: property.id,
            actorUserId: req.user.id,
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
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }
  }

  /**
   * Amends dates or party size. Old nights are released and new ones claimed in
   * one transaction, and the rate snapshot is recomputed from the room type.
   */
  async update(req: any, reservationId: string, body: any) {
    const property = await this.activeProperty(req);
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
    const nightlyRate = fromDecimal(String(roomType?.baseRate ?? rr.nightlyRate));
    const subtotal = multiply(nightlyRate, nights.length).minor / 100;

    const datesChanged = checkIn !== reservation.checkInDate || checkOut !== reservation.checkOutDate;

    try {
      return await db.transaction(async (tx: any) => {
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
          subtotal: brand(String(subtotal)),
          totalAmount: brand(String(subtotal)),
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
            organizationId: req.user.organizationId,
            propertyId: property.id,
            actorUserId: req.user.id,
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
          subtotal: String(subtotal),
          totalAmount: String(subtotal),
          roomReallocated: datesChanged && !!rr.roomId,
        };
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }
  }

  /** Cancels a reservation. A reason is mandatory and always audited. */
  async cancel(req: any, reservationId: string, reason: string) {
    const property = await this.activeProperty(req);
    const reservation = await db.orm.public.Reservation
      .where({ id: brand(reservationId), propertyId: brand(property.id) })
      .first();
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (reservation.status === 'CANCELLED') return { id: reservationId, status: 'CANCELLED' };
    if (['CHECKED_IN', 'CHECKED_OUT'].includes(String(reservation.status))) {
      throw new ConflictException(`Cannot cancel a ${reservation.status} reservation`);
    }
    if (!reason?.trim()) throw new BadRequestException('A cancellation reason is required');

    return db.transaction(async (tx: any) => {
      const rrs = await tx.orm.public.ReservationRoom
        .where({ reservationId: brand(reservationId) })
        .all();
      for (const rr of rrs) {
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
          organizationId: req.user.organizationId,
          propertyId: property.id,
          actorUserId: req.user.id,
          action: 'reservation.cancel',
          resourceType: 'Reservation',
          resourceId: reservationId,
          reason: reason.trim(),
          outcome: 'SUCCESS',
        },
        tx,
      );

      return { id: reservationId, status: 'CANCELLED', releasedRoomLines: rrs.length };
    });
  }

  async detail(req: any, reservationId: string) {
    const property = await this.activeProperty(req);
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

  async list(req: any, opts: { status?: string; checkIn?: DateOnly; checkOut?: DateOnly; search?: string; page: number; pageSize: number }) {
    const property = await this.activeProperty(req);
    const take = Math.min(Math.max(opts.pageSize, 1), 100);
    const skip = Math.max(opts.page, 1) - 1;

    let rows = await db.orm.public.Reservation
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