import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { db } from '../src/prisma/db.js';
import { brand, ts } from '../src/prisma/compat.js';
import { addDays, enumerateNights, toDateOnly } from '../src/common/dates.js';
import { RoomHoldService } from '../src/booking-service/room-hold.service.js';
import type { ActorContext } from '../src/contracts/shared.js';

/**
 * Database-backed room-hold concurrency tests.
 *
 * These run against the real Postgres and Redis, because the whole point is the
 * database constraint and the transaction boundary — a mock would prove nothing.
 * They create their own far-future dates so they never collide with seeded data,
 * and clean up after themselves.
 */

const config = {
  get: (key: string) => ({ 'redis.host': '127.0.0.1', 'redis.port': 6379 } as Record<string, unknown>)[key],
} as unknown as ConfigService;

let holds: RoomHoldService;
let propertyId: string;
let roomId: string;
let roomTypeId: string;
let guestId: string;

/** A unique base date per run so repeated runs never clash. */
const BASE_OFFSET = 500 + (Date.now() % 1000);
const baseDate = () => addDays(toDateOnly(new Date()), BASE_OFFSET);

function actor(userId: string): ActorContext {
  return { id: userId, organizationId: 'test-org', activePropertyId: propertyId, permissions: [] };
}

async function makeReservationRoom(checkIn: string, checkOut: string): Promise<string> {
  const reservation = await db.orm.public.Reservation.create({
    propertyId: brand(propertyId),
    bookingCode: brand(`TST-${randomUUID().slice(0, 8)}`),
    status: brand('CONFIRMED'),
    source: brand('DIRECT'),
    primaryGuestId: brand(guestId),
    checkInDate: brand(checkIn),
    checkOutDate: brand(checkOut),
    adults: brand(1),
    children: brand(0),
    currencyCode: brand('INR'),
    subtotal: brand('0.00'),
    taxTotal: brand('0.00'),
    totalAmount: brand('0.00'),
  });
  const rr = await db.orm.public.ReservationRoom.create({
    reservationId: brand(reservation.id),
    roomTypeId: brand(roomTypeId),
    roomId: brand(roomId),
    adults: brand(1),
    children: brand(0),
    nightlyRate: brand('0.00'),
  });
  return rr.id;
}

/** Removes every inventory/booking row this suite created for the room. */
async function cleanup() {
  const rows = await db.orm.public.RoomNightInventory.where({ roomId: brand(roomId) }).all();
  for (const row of rows) {
    if (row.reservationRoomId) {
      await db.orm.public.RoomNightInventory.where({ id: brand(row.id) }).deleteAll();
    }
  }
}

beforeAll(async () => {
  holds = new RoomHoldService(config);
  await holds.onModuleInit();

  const room = await db.orm.public.Room.where((r) => r.isActive.eq(true)).first();
  if (!room) throw new Error('No active room to test against — seed the database first.');
  roomId = room.id;
  roomTypeId = room.roomTypeId;
  propertyId = room.propertyId;

  const guest = await db.orm.public.Guest.where({ organizationId: brand((await db.orm.public.Property.where({ id: brand(propertyId) }).first())!.organizationId) }).first();
  if (!guest) throw new Error('No guest to test against — seed the database first.');
  guestId = guest.id;
});

afterAll(async () => {
  await cleanup();
  await holds.onModuleDestroy();
});

describe('room holds (database-backed)', () => {
  it('a successful hold blocks another user for overlapping dates', async () => {
    const checkIn = baseDate();
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);
    expect(held.holdId).toBeTruthy();
    expect(held.remainingMs).toBeGreaterThan(0);

    await expect(holds.acquire(b, roomId, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });

    await holds.release(a, held.holdId);
  });

  it('exactly one of several simultaneous acquisitions wins', async () => {
    const checkIn = addDays(baseDate(), 10);
    const checkOut = addDays(checkIn, 2);
    const contenders = Array.from({ length: 6 }, () => actor(randomUUID()));

    const results = await Promise.allSettled(
      contenders.map((a) => holds.acquire(a, roomId, checkIn, checkOut)),
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status?: number })?.status === 409,
    );

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(5);

    const winner = winners[0] as PromiseFulfilledResult<{ holdId: string }>;
    await holds.release(contenders[results.indexOf(winners[0])], winner.value.holdId);
  });

  it('non-overlapping dates for the same room are allowed', async () => {
    const checkIn = addDays(baseDate(), 20);
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const first = await holds.acquire(a, roomId, checkIn, checkOut);
    // Starts the day the first hold checks out — the [in, out) convention means no clash.
    const second = await holds.acquire(b, roomId, checkOut, addDays(checkOut, 2));
    expect(second.holdId).toBeTruthy();

    await holds.release(a, first.holdId);
    await holds.release(b, second.holdId);
  });

  it('an expired hold does not block a new acquisition', async () => {
    const checkIn = addDays(baseDate(), 30);
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);

    // Force the hold into the past without waiting ten minutes.
    const rows = await db.orm.public.RoomNightInventory.where({ holdToken: brand(held.holdId) }).all();
    for (const row of rows) {
      await db.orm.public.RoomNightInventory.where({ id: brand(row.id) }).update({
        holdExpiresAt: ts(new Date(Date.now() - 60_000)),
      });
    }

    const next = await holds.acquire(b, roomId, checkIn, checkOut);
    expect(next.holdId).toBeTruthy();
    await holds.release(b, next.holdId);
  });

  it('releasing frees the nights for another user', async () => {
    const checkIn = addDays(baseDate(), 40);
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);
    await holds.release(a, held.holdId);

    const next = await holds.acquire(b, roomId, checkIn, checkOut);
    expect(next.holdId).toBeTruthy();
    await holds.release(b, next.holdId);
  });

  it('one user cannot release another user\'s hold', async () => {
    const checkIn = addDays(baseDate(), 50);
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);
    await expect(holds.release(b, held.holdId)).rejects.toMatchObject({ status: 404 });

    // Still owned by A.
    const stillHeld = await holds.unavailableRooms([roomId], enumerateNights(checkIn, checkOut), b.id);
    expect(stillHeld.has(roomId)).toBe(true);

    await holds.release(a, held.holdId);
  });

  it('converting a hold turns it into a booking and blocks others', async () => {
    const checkIn = addDays(baseDate(), 60);
    const checkOut = addDays(checkIn, 2);
    const nights = enumerateNights(checkIn, checkOut);
    const a = actor(randomUUID());
    const b = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);
    const rrId = await makeReservationRoom(checkIn, checkOut);

    await db.transaction(async (tx: any) => {
      await holds.convert(tx, a, held.holdId, rrId, nights);
    });

    // The hold token is gone; the nights are committed.
    const booked = await db.orm.public.RoomNightInventory.where({ reservationRoomId: brand(rrId) }).all();
    expect(booked).toHaveLength(nights.length);

    await expect(holds.acquire(b, roomId, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });
  });

  it('a stale token cannot convert', async () => {
    const checkIn = addDays(baseDate(), 70);
    const checkOut = addDays(checkIn, 2);
    const nights = enumerateNights(checkIn, checkOut);
    const a = actor(randomUUID());
    const rrId = await makeReservationRoom(checkIn, checkOut);

    await expect(
      db.transaction(async (tx: any) => {
        await holds.convert(tx, a, randomUUID(), rrId, nights);
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('the sweep removes expired holds and leaves live ones', async () => {
    const checkIn = addDays(baseDate(), 80);
    const checkOut = addDays(checkIn, 2);
    const a = actor(randomUUID());

    const held = await holds.acquire(a, roomId, checkIn, checkOut);
    const rows = await db.orm.public.RoomNightInventory.where({ holdToken: brand(held.holdId) }).all();
    for (const row of rows) {
      await db.orm.public.RoomNightInventory.where({ id: brand(row.id) }).update({
        holdExpiresAt: ts(new Date(Date.now() - 60_000)),
      });
    }

    const removed = await holds.expireSweep();
    expect(removed).toBeGreaterThanOrEqual(rows.length);

    const remaining = await db.orm.public.RoomNightInventory.where({ holdToken: brand(held.holdId) }).all();
    expect(remaining).toHaveLength(0);
  });
});
