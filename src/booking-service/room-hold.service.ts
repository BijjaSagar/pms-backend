import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, ts } from '../prisma/compat.js';
import { enumerateNights, parseTimestamp, type DateOnly } from '../common/dates.js';
import { isUniqueViolation, UNIQUE } from '../common/db-errors.js';
import {
  BOOKING_EVENTS_CHANNEL,
  type BookingEvent,
  type HoldResult,
} from '../contracts/booking.messages.js';
import type { ActorContext } from '../contracts/shared.js';

/** How long a selected room stays reserved for the person selecting it. */
const HOLD_TTL_MS = 10 * 60 * 1000;

/**
 * Selection-time room holds — database-backed.
 *
 * A hold is one `RoomNightInventory` row per room-night with `holdToken` set and
 * `reservationRoomId` null; a booking is the same row with `reservationRoomId`
 * set and the hold fields cleared. Because the table keeps
 * `@@unique([roomId, stayDate])`, that single constraint is the database-enforced
 * authority that stops two users claiming the same night — for holds and for
 * bookings alike, across every application instance.
 *
 * The row carries the hold's `holdExpiresAt`, so an expired hold is ignored by
 * every read and can be reclaimed without waiting for the sweep. Redis is used
 * only to publish real-time availability events to the gateway; it is never the
 * source of truth.
 */
@Injectable()
export class RoomHoldService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomHoldService.name);
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis({
      host: config.get<string>('redis.host') ?? '127.0.0.1',
      port: config.get<number>('redis.port') ?? 6379,
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.ping();
    this.logger.log('Room holds ready (database-backed; Redis for events only)');
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  /** Validates that the room exists at the property and is bookable. */
  private async bookableRoom(actor: ActorContext, roomId: string) {
    const propertyId = actor.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    if (typeof roomId !== 'string' || !roomId) {
      throw new BadRequestException('roomId must be a non-empty string');
    }
    const room = await db.orm.public.Room
      .where({ id: brand(roomId), propertyId: brand(propertyId) })
      .first();
    if (!room) throw new NotFoundException('Room not found in this property');
    if (!room.isActive) throw new ConflictException('That room is not active');
    if (room.status === 'OUT_OF_ORDER') {
      throw new ConflictException('That room is out of order and cannot be held');
    }
    return { propertyId, room };
  }

  /**
   * Reserves every night of the range for this user.
   *
   * Expired hold rows for the requested nights are removed first so they cannot
   * block; committed rows and live holds owned by another user raise 409. The
   * inserts run inside one transaction, so a lost race is a unique violation
   * (`RoomNightInventory_roomId_stayDate_key`) rather than a partial hold.
   */
  async acquire(actor: ActorContext, roomId: string, checkIn: DateOnly, checkOut: DateOnly): Promise<HoldResult> {
    const { propertyId, room } = await this.bookableRoom(actor, roomId);
    const nights = enumerateNights(checkIn, checkOut);
    if (nights.length === 0) throw new BadRequestException('The stay must be at least one night');

    const nightSet = new Set(nights);
    const holdId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS);

    try {
      await db.transaction(async (tx: any) => {
        const existing = await tx.orm.public.RoomNightInventory
          .where({ roomId: brand(room.id) })
          .all();
        const now = Date.now();

        for (const row of existing) {
          if (!nightSet.has(String(row.stayDate))) continue;
          if (row.reservationRoomId) {
            throw new ConflictException('That room is already booked for one or more of those nights');
          }
          const exp = row.holdExpiresAt ? parseTimestamp(row.holdExpiresAt).getTime() : 0;
          if (exp > now && row.holdUserId !== actor.id) {
            throw new ConflictException(
              'Another user is booking that room for these nights. Choose a different room.',
            );
          }
          // Expired, or this user's own earlier hold: clear it so the insert can take the night.
          await tx.orm.public.RoomNightInventory.where({ id: brand(row.id) }).deleteAll();
        }

        for (const night of nights) {
          await tx.orm.public.RoomNightInventory.create({
            roomId: brand(room.id),
            stayDate: brand(night),
            holdToken: brand(holdId),
            holdUserId: brand(actor.id),
            holdExpiresAt: ts(expiresAt),
            createdAt: ts(new Date()),
          });
        }
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        this.logger.warn(`hold conflict room=${room.id} user=${actor.id} nights=${nights.length}`);
        throw e;
      }
      if (isUniqueViolation(e, UNIQUE.ROOM_NIGHT)) {
        this.logger.warn(`hold race lost room=${room.id} user=${actor.id}`);
        throw new ConflictException(
          'Another user just took that room for these nights. Choose a different room.',
        );
      }
      throw e;
    }

    await this.publish({
      type: 'hold',
      propertyId,
      roomId: room.id,
      nights,
      holdId,
      userId: actor.id,
      at: new Date().toISOString(),
    });
    this.logger.log(`hold acquired room=${room.id} hold=${holdId} nights=${nights.length}`);

    return { holdId, roomId: room.id, nights, expiresAt: expiresAt.toISOString(), remainingMs: HOLD_TTL_MS };
  }

  /** Extends a hold the caller still owns, by a full TTL from now. */
  async refresh(actor: ActorContext, holdId: string): Promise<HoldResult> {
    const rows = await db.orm.public.RoomNightInventory
      .where({ holdToken: brand(holdId) })
      .all();
    if (rows.length === 0) throw new NotFoundException('That hold has expired or does not exist');

    const mine = rows.filter((r) => r.holdUserId === actor.id && !r.reservationRoomId);
    if (mine.length !== rows.length) throw new NotFoundException('That hold does not belong to you');

    const now = Date.now();
    if (mine.some((r) => !r.holdExpiresAt || parseTimestamp(r.holdExpiresAt).getTime() <= now)) {
      throw new ConflictException('That hold has expired. Select the room again.');
    }

    const expiresAt = new Date(now + HOLD_TTL_MS);
    await db.transaction(async (tx: any) => {
      for (const r of mine) {
        await tx.orm.public.RoomNightInventory.where({ id: brand(r.id) }).update({
          holdExpiresAt: ts(expiresAt),
        });
      }
    });

    return {
      holdId,
      roomId: mine[0].roomId,
      nights: mine.map((r) => String(r.stayDate)),
      expiresAt: expiresAt.toISOString(),
      remainingMs: HOLD_TTL_MS,
    };
  }

  /** Releases a hold the caller owns. Idempotent; never touches another user's hold. */
  async release(actor: ActorContext, holdId: string): Promise<{ ok: true }> {
    const rows = await db.orm.public.RoomNightInventory
      .where({ holdToken: brand(holdId) })
      .all();
    if (rows.length === 0) return { ok: true };

    const mine = rows.filter((r) => r.holdUserId === actor.id && !r.reservationRoomId);
    if (mine.length === 0) throw new NotFoundException('That hold does not belong to you');

    const nights = mine.map((r) => String(r.stayDate));
    const roomId = mine[0].roomId;
    await db.transaction(async (tx: any) => {
      for (const r of mine) {
        await tx.orm.public.RoomNightInventory.where({ id: brand(r.id) }).deleteAll();
      }
    });

    await this.publish({
      type: 'release',
      propertyId: actor.activePropertyId ?? '',
      roomId,
      nights,
      holdId,
      userId: actor.id,
      at: new Date().toISOString(),
    });
    return { ok: true };
  }

  /**
   * Converts a live hold into permanent inventory rows inside the caller's
   * booking transaction.
   *
   * Called with the booking's `tx`, so the row update and the reservation commit
   * together. If the hold has expired, been released, or belongs to someone
   * else, it throws and the whole booking rolls back — a stale token can never
   * confirm a reservation.
   */
  async convert(
    tx: any,
    actor: ActorContext,
    holdId: string,
    reservationRoomId: string,
    nights: string[],
  ): Promise<void> {
    const rows = await tx.orm.public.RoomNightInventory
      .where({ holdToken: brand(holdId) })
      .all();

    const now = Date.now();
    const live = rows.filter(
      (r: any) =>
        r.holdUserId === actor.id &&
        !r.reservationRoomId &&
        r.holdExpiresAt &&
        parseTimestamp(r.holdExpiresAt).getTime() > now,
    );

    const liveNights = new Set(live.map((r: any) => String(r.stayDate)));
    const coversAll = nights.every((n) => liveNights.has(n)) && liveNights.size === nights.length;
    if (!coversAll) {
      throw new ConflictException(
        'Your hold has expired or no longer matches these dates. Select the room again.',
      );
    }

    for (const row of live) {
      await tx.orm.public.RoomNightInventory.where({ id: brand(row.id) }).update({
        reservationRoomId: brand(reservationRoomId),
        holdToken: brand(null),
        holdUserId: brand(null),
        holdExpiresAt: brand(null),
      });
    }
  }

  /** Announces a confirmed booking so other screens refresh. */
  async afterBooked(actor: ActorContext, roomId: string | null, nights: string[]): Promise<void> {
    if (!roomId) return;
    await this.publish({
      type: 'booked',
      propertyId: actor.activePropertyId ?? '',
      roomId,
      nights,
      holdId: null,
      userId: actor.id,
      at: new Date().toISOString(),
    });
  }

  /** Announces a cancellation so held screens drop the freed nights. */
  async announceCancelled(actor: ActorContext, roomId: string | null, nights: string[]): Promise<void> {
    if (!roomId) return;
    await this.publish({
      type: 'cancelled',
      propertyId: actor.activePropertyId ?? '',
      roomId,
      nights,
      holdId: null,
      userId: actor.id,
      at: new Date().toISOString(),
    });
  }

  /**
   * Rooms among `roomIds` that this user cannot take for `nights`: any night is
   * committed, or is under a live hold owned by someone else. The caller's own
   * hold is excluded so their selection still shows as available to them.
   */
  async unavailableRooms(roomIds: string[], nights: string[], actorId: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (roomIds.length === 0 || nights.length === 0) return out;

    const nightSet = new Set(nights);
    const rows = await db.orm.public.RoomNightInventory
      .where((m) => m.roomId.in(roomIds))
      .all();

    const now = Date.now();
    for (const r of rows) {
      if (!nightSet.has(String(r.stayDate))) continue;
      if (r.reservationRoomId) {
        out.add(r.roomId);
        continue;
      }
      const exp = r.holdExpiresAt ? parseTimestamp(r.holdExpiresAt).getTime() : 0;
      if (exp > now && r.holdUserId && r.holdUserId !== actorId) out.add(r.roomId);
    }
    return out;
  }

  /**
   * Deletes hold rows whose ten minutes have passed.
   *
   * Purely a cleanup: expired rows are already invisible to every read, so this
   * only stops them accumulating. It never touches a row that has been converted
   * (reservationRoomId set) or renewed (holdExpiresAt in the future).
   */
  async expireSweep(): Promise<number> {
    // Only uncommitted rows can be holds, so this scan is bounded by live and
    // lapsed holds rather than by every booking ever made. The comparison is
    // done in JS with `parseTimestamp` because the stored timestamp comes back
    // in a shape `new Date` would read in the wrong zone.
    const holdRows = await db.orm.public.RoomNightInventory
      .where((r) => r.reservationRoomId.isNull())
      .all();
    const now = Date.now();
    const expired = holdRows.filter(
      (row) => row.holdExpiresAt && parseTimestamp(row.holdExpiresAt).getTime() <= now,
    );
    if (expired.length === 0) return 0;

    await db.transaction(async (tx: any) => {
      for (const row of expired) {
        await tx.orm.public.RoomNightInventory.where({ id: brand(row.id) }).deleteAll();
      }
    });
    this.logger.log(`hold sweep removed ${expired.length} expired row(s)`);
    return expired.length;
  }

  private async publish(event: BookingEvent): Promise<void> {
    try {
      await this.redis.publish(BOOKING_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      // A failed notification must never fail the booking itself; clients fall
      // back to re-fetching availability.
      this.logger.warn(`availability event publish failed: ${(err as Error).message}`);
    }
  }
}
