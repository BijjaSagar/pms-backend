/**
 * Phase 10 concurrency verification.
 *
 * Section 14 requires that "two simultaneous reservations for the same physical
 * room/date must never both succeed". The schema carries the guarantee — a
 * unique constraint on RoomNightInventory(roomId, stayDate) — but nothing had
 * ever actually tried it, so the constraint was untested.
 *
 * The requests are issued concurrently on purpose. A sequential test proves
 * nothing here: read-check-write is correct in single-threaded use, and the bug
 * only appears when two callers read availability before either has written.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

/** How many callers race for the same room and night. */
const RACERS = 6;

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, init: RequestInit = {}, cookie = '') {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, raw: text };
}

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], status: res.status };
}

async function loginWhenAllowed(email: string, password = PASSWORD) {
  let attempt = await login(email, password);
  if (attempt.status !== 429) return attempt;
  await new Promise((r) => setTimeout(r, 65_000));
  attempt = await login(email, password);
  return attempt;
}

const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

/** Business date a few days out, so no other suite's fixture overlaps it. */
function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

async function main() {
  await cleanup();

  const admin = (await loginWhenAllowed('admin@dev.local')).cookie;
  const fd = (await loginWhenAllowed('frontdesk@dev.local')).cookie;
  if ((await call('/properties', {}, admin)).status !== 200) {
    console.error('Session setup failed; wait 60s and re-run.');
    process.exitCode = 1;
    return;
  }
  await pinProperty(admin);

  const types = await call('/room-types', {}, admin);
  if (!Array.isArray(types.body) || types.body.length === 0) {
    console.error('No room types available.');
    process.exitCode = 1;
    return;
  }

  // Find a room type with at least one free room across the whole window.
  const checkIn = futureDate(40);
  const checkOut = futureDate(42);

  let roomType: any = null;
  let room: any = null;
  for (const t of types.body) {
    const avail = await call(
      `/availability?checkIn=${checkIn}&checkOut=${checkOut}&roomTypeId=${t.id}`, {}, admin);
    if (Array.isArray(avail.body?.available) && avail.body.available.length > 0) {
      roomType = t;
      room = avail.body.available[0];
      break;
    }
  }

  if (!room) {
    console.error('No free room found for the concurrency window.');
    process.exitCode = 1;
    return;
  }
  console.log(`Racing ${RACERS} bookings for room ${room.roomNumber ?? room.id}, ${checkIn} → ${checkOut}\n`);

  // ---------------------------------------------------------- identical races
  // Every racer wants the same physical room and the same nights.
  const guests: string[] = [];
  for (let i = 0; i < RACERS; i++) {
    const g = await call('/guests', {
      method: 'POST',
      body: JSON.stringify({
        firstName: `Race${i}`, lastName: 'p10-race',
        email: `p10-race-${i}@example.com`,
      }),
    }, fd);
    guests.push(g.body?.id);
  }
  check('a guest could be created for each racer', guests.every(Boolean), `${guests.filter(Boolean).length}/${RACERS}`);

  // Fired together with no awaits in between, so they are genuinely in flight
  // together rather than merely issued in sequence.
  const results = await Promise.all(
    guests.map((guestId) =>
      call('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          primaryGuestId: guestId,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          adults: 1,
          children: 0,
          roomTypeId: roomType.id,
          roomId: room.id,
        }),
      }, fd),
    ),
  );

  const created = results.filter((r) => r.status === 201 || r.status === 200);
  const conflicts = results.filter((r) => r.status === 409);

  check(
    `only one of ${RACERS} simultaneous bookings for the same room succeeds`,
    created.length === 1,
    `${created.length} succeeded, ${conflicts.length} conflicted, statuses=${results.map((r) => r.status).join(',')}`,
  );
  check('every loser gets a 409 conflict, not a 500',
    created.length + conflicts.length === RACERS,
    `accounted for ${created.length + conflicts.length}/${RACERS}`);
  check('the conflict message is actionable',
    conflicts.length > 0 && /availability|refresh|another room/i.test(conflicts[0].raw),
    conflicts[0]?.raw?.slice(0, 120));

  // -------------------------------------------------------- database truth
  const nights = await q(
    `SELECT count(*)::int AS n FROM "RoomNightInventory"
     WHERE "roomId" = $1 AND "stayDate" >= $2::date AND "stayDate" < $3::date`,
    [room.id, checkIn, checkOut],
  );
  check(
    'the database holds exactly one allocation per night',
    nights.rows[0].n === 2,
    `${nights.rows[0].n} rows for a 2-night stay`,
  );

  const dupes = await q(
    `SELECT "roomId", "stayDate", count(*)::int AS n FROM "RoomNightInventory"
     GROUP BY "roomId", "stayDate" HAVING count(*) > 1`);
  check('no room-night is allocated twice anywhere in the database', dupes.rowCount === 0,
    `${dupes.rowCount} duplicated night(s)`);

  // ------------------------------------------------------------- availability
  const availAfter = await call(
    `/availability?checkIn=${checkIn}&checkOut=${checkOut}&roomTypeId=${roomType.id}`, {}, admin);
  check(
    'availability reflects the booking that won',
    Array.isArray(availAfter.body?.available)
      && !availAfter.body.available.some((r: any) => r.id === room.id),
    `${availAfter.body?.available?.length ?? 0} still listed`,
  );

  // ------------------------------------------------------- overlapping window
  // A second booking for the same room that overlaps only in part must also lose.
  const overlapGuest = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Overlap', lastName: 'p10-overlap', email: 'p10-overlap@example.com' }),
  }, fd);

  const overlapCheckOut = futureDate(41); // one night, inside the same window
  const overlap = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: overlapGuest.body.id,
      checkInDate: checkIn,
      checkOutDate: overlapCheckOut,
      adults: 1,
      children: 0,
      roomTypeId: roomType.id,
      roomId: room.id,
    }),
  }, fd);

  check('a partially overlapping booking for the same room is refused (409)',
    overlap.status === 409, `status=${overlap.status}`);

  // The night it would have needed must not exist as a new allocation.
  const overlapNight = await q(
    `SELECT count(*)::int AS n FROM "RoomNightInventory"
     WHERE "roomId" = $1 AND "stayDate" = $2::date`,
    [room.id, checkIn],
  );
  check('the refused overlap left no trace in room-night inventory',
    overlapNight.rows[0].n === 1, `${overlapNight.rows[0].n} rows for the contested night`);

  // ------------------------------------------------------------ adjacent dates
  // Checking out on a given date and checking in the same date is not an overlap,
  // so this must be allowed. A too-eager constraint here would quietly corrupt
  // the booking model.
  const adjacentIn = futureDate(42);
  const adjacentOut = futureDate(43);
  const adjacentGuest = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Adjacent', lastName: 'p10-adjacent', email: 'p10-adjacent@example.com' }),
  }, fd);
  const adjacent = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: adjacentGuest.body.id,
      checkInDate: adjacentIn,
      checkOutDate: adjacentOut,
      adults: 1,
      children: 0,
      roomTypeId: roomType.id,
      roomId: room.id,
    }),
  }, fd);

  check('a back-to-back stay starting the day the previous one ends is allowed',
    adjacent.status === 201 || adjacent.status === 200, `status=${adjacent.status}`);

  const adjacentNight = await q(
    `SELECT count(*)::int AS n FROM "RoomNightInventory"
     WHERE "roomId" = $1 AND "stayDate" = $2::date`,
    [room.id, adjacentIn],
  );
  check('the back-to-back stay got its own night', adjacentNight.rows[0].n === 1,
    `${adjacentNight.rows[0].n} rows`);

  // --------------------------------------------------------- concurrent cancel
  // Cancelling the winner must release the nights, and doing it twice
  // concurrently must not double-release or error.
  const winner = created[0]?.body?.id;
  if (winner) {
    const cancels = await Promise.all([
      call(`/reservations/${winner}/cancel`, {
        method: 'POST', body: JSON.stringify({ reason: 'p10 concurrency test' }),
      }, fd),
      call(`/reservations/${winner}/cancel`, {
        method: 'POST', body: JSON.stringify({ reason: 'p10 concurrency test duplicate' }),
      }, fd),
    ]);
    const okCancels = cancels.filter((c) => c.status < 300);
    check('concurrent cancellation does not produce a server error',
      cancels.every((c) => c.status < 500), `statuses=${cancels.map((c) => c.status).join(',')}`);
    check('cancellation is idempotent under concurrency',
      okCancels.length >= 1, `${okCancels.length} accepted of ${cancels.length}`);

    const afterCancel = await call(
      `/availability?checkIn=${checkIn}&checkOut=${checkOut}&roomTypeId=${roomType.id}`, {}, admin);
    check('cancelling releases the nights back to availability',
      Array.isArray(afterCancel.body?.available)
        && afterCancel.body.available.some((r: any) => r.id === room.id),
      `${afterCancel.body?.available?.length ?? 0} listed`);
  } else {
    check('concurrent cancellation does not produce a server error', false, 'no winner to cancel');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });