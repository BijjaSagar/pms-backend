/**
 * Phase 5A acceptance checks.
 *
 * Dates are anchored to the property's business date so that "nights stayed" is
 * non-zero. Far-future dates would check a guest in for a stay that has not
 * begun, and the checkout would correctly bill nothing.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, init: RequestInit = {}, cookie = '') {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function login(email: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const tag = `p5a-${Date.now()}`;
const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

async function stateOf(reservationId: string) {
  const r = await q(
    `SELECT r.status, r."checkedInAt", r."checkedOutAt",
            f.status AS folio_status, f.id AS folio_id, rm.status AS room_status
     FROM "Reservation" r
     LEFT JOIN "Folio" f ON f."reservationId" = r.id
     LEFT JOIN "ReservationRoom" rr ON rr."reservationId" = r.id
     LEFT JOIN "Room" rm ON rm.id = rr."roomId"
     WHERE r.id = $1`, [reservationId]);
  return r.rows[0];
}

async function main() {
  // Self-cleaning: a previous run leaves an in-house stay holding a room, which
  // would starve this run of availability. Removing it here is what makes the
  // suite repeatable rather than a one-shot script.
  await cleanup();

  const admin = await login('admin@dev.local');
  await pinProperty(admin);
  const fd = await login('frontdesk@dev.local');

  const types = await call('/room-types', {}, admin);
  const rt = types.body.find((t: any) => t.isActive);
  const g = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Phase5', lastName: tag }),
  }, admin);
  const guestId = g.body.id;

  // Property business date drives every "today" calculation.
  const arrivals0 = await call('/front-desk/arrivals', {}, fd);
  if (arrivals0.status !== 200 || !/^\d{4}-\d{2}-\d{2}$/.test(arrivals0.body?.businessDate ?? '')) {
    console.error(
      `Could not read the property business date (status=${arrivals0.status}). ` +
      'This is usually login throttling from a recent run; wait 60s and retry.',
    );
    console.error(JSON.stringify(arrivals0.body));
    process.exitCode = 1;
    return;
  }
  const today = arrivals0.body.businessDate;
  const ci = today;               // arrive today
  const co = addDays(today, 2);   // two nights booked
  check('business date is derived server-side', /^\d{4}-\d{2}-\d{2}$/.test(today), today);

  const avail = await call(
    `/availability?checkIn=${ci}&checkOut=${co}&roomTypeId=${rt.id}`, {}, admin);
  const rooms = avail.body.available;
  check('enough rooms available for the workflow', rooms.length >= 3, `${rooms.length} available`);

  const book = async (roomId?: string, from = ci, to = co) =>
    call('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        primaryGuestId: guestId, checkInDate: from, checkOutDate: to,
        adults: 1, children: 0, roomTypeId: rt.id, ...(roomId ? { roomId } : {}),
      }),
    }, admin);

  // ---------- check-in ----------
  const noRoom = await book();
  const ciNoRoom = await call(`/reservations/${noRoom.body.id}/check-in`, { method: 'POST', body: '{}' }, admin);
  check('check-in without a room is rejected (400)', ciNoRoom.status === 400, `status=${ciNoRoom.status}`);

  const res1 = await book(rooms[0].id);
  check('reservation created', res1.status === 201, `status=${res1.status}`);

  const ci1 = await call(`/reservations/${res1.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  check('front desk can check a guest in', ci1.status === 201 || ci1.status === 200, `status=${ci1.status}`);
  check('a folio was opened at check-in', !!ci1.body?.folioId, String(ci1.body?.folioId));

  let st = await stateOf(res1.body.id);
  check('reservation is CHECKED_IN', st.status === 'CHECKED_IN', st.status);
  check('folio is OPEN', st.folio_status === 'OPEN', String(st.folio_status));
  check('room is OCCUPIED_CLEAN', st.room_status === 'OCCUPIED_CLEAN', String(st.room_status));

  // ---------- idempotent check-in ----------
  const ci2 = await call(`/reservations/${res1.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  check('repeat check-in reports idempotent', ci2.body?.idempotent === true);
  const folioCount = await q(
    `SELECT count(*)::int AS n FROM "Folio" WHERE "reservationId" = $1`, [res1.body.id]);
  check('repeat check-in did NOT open a second folio', folioCount.rows[0].n === 1, `${folioCount.rows[0].n} folios`);

  // ---------- checkout blocked while owing ----------
  const coBlocked = await call(`/reservations/${res1.body.id}/check-out`, { method: 'POST', body: '{}' }, fd);
  check('checkout with an unpaid balance is blocked (409)', coBlocked.status === 409, `status=${coBlocked.status}`);
  check('the message states the amount owing', /Outstanding balance/i.test(JSON.stringify(coBlocked.body)));

  // A blocked checkout must leave everything exactly as it was.
  st = await stateOf(res1.body.id);
  check('blocked checkout left the stay CHECKED_IN', st.status === 'CHECKED_IN', st.status);
  check('blocked checkout left the folio OPEN', st.folio_status === 'OPEN', String(st.folio_status));
  check('blocked checkout left the room OCCUPIED_CLEAN', st.room_status === 'OCCUPIED_CLEAN', String(st.room_status));

  // The room charge was posted before the balance check, so it is already there.
  const bal0 = await call(`/folios/${ci1.body.folioId}/balance`, {}, admin);
  check('a room charge was posted for the night stayed', parseFloat(bal0.body.charges) > 0, bal0.body.charges);
  check('tax is computed, not zero', parseFloat(bal0.body.tax) > 0, bal0.body.tax);
  check('total equals charges plus tax',
    Math.abs((parseFloat(bal0.body.charges) + parseFloat(bal0.body.tax)) - parseFloat(bal0.body.total)) < 0.001,
    `${bal0.body.charges} + ${bal0.body.tax} = ${bal0.body.total}`);

  // ---------- front desk cannot waive ----------
  const fdWaive = await call(`/reservations/${res1.body.id}/check-out`, {
    method: 'POST', body: JSON.stringify({ overrideReason: 'cash given at desk' }),
  }, fd);
  check('front desk cannot waive a balance (403)', fdWaive.status === 403, `status=${fdWaive.status}`);

  // ---------- manager waives ----------
  const adminWaive = await call(`/reservations/${res1.body.id}/check-out`, {
    method: 'POST', body: JSON.stringify({ overrideReason: 'corporate direct billing' }),
  }, admin);
  check('admin can waive with a reason', adminWaive.status === 201 || adminWaive.status === 200, `status=${adminWaive.status}`);
  check('waiver is flagged in the result', adminWaive.body?.overridden === true);

  st = await stateOf(res1.body.id);
  check('reservation is now CHECKED_OUT', st.status === 'CHECKED_OUT', st.status);
  check('folio is now CLOSED', st.folio_status === 'CLOSED', String(st.folio_status));
  check('room is now VACANT_DIRTY', st.room_status === 'VACANT_DIRTY', String(st.room_status));

  const task = await q(
    `SELECT status, type FROM "HousekeepingTask" WHERE "roomId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [rooms[0].id]);
  check('a checkout clean task was created', task.rows.length === 1 && task.rows[0].type === 'CHECKOUT_CLEAN',
    JSON.stringify(task.rows[0] ?? null));

  const coAgain = await call(`/reservations/${res1.body.id}/check-out`, { method: 'POST', body: '{}' }, admin);
  check('repeat checkout is idempotent', coAgain.body?.idempotent === true);

  const chargeCount = await q(
    `SELECT count(*)::int AS n FROM "FolioItem" WHERE "folioId" = $1 AND type = 'ROOM_CHARGE'`,
    [ci1.body.folioId]);
  check('exactly one room charge line per occupied night, no duplicates', chargeCount.rows[0].n === 1,
    `${chargeCount.rows[0].n} lines for 1 night stayed`);

  // ---------- settled checkout needs no override ----------
  const res2 = await book(rooms[1].id);
  const ci2b = await call(`/reservations/${res2.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  check('second guest checked in', ci2b.status === 201 || ci2b.status === 200,
    `status=${ci2b.status} ${JSON.stringify(ci2b.body).slice(0, 140)}`);
  const f2 = (await q(`SELECT id FROM "Folio" WHERE "reservationId" = $1`, [res2.body.id])).rows[0].id;
  const b2 = await call(`/folios/${f2}/balance`, {}, admin);
  check('second folio has a computable total', parseFloat(b2.body.total) > 0, b2.body.total);

  const pay = await call(`/folios/${f2}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount: b2.body.total, method: 'CASH', idempotencyKey: `pay-${tag}` }),
  }, fd);
  check('front desk can record a payment', pay.status === 201 || pay.status === 200, `status=${pay.status}`);

  await call(`/folios/${f2}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount: b2.body.total, method: 'CASH', idempotencyKey: `pay-${tag}` }),
  }, fd);
  const b3 = await call(`/folios/${f2}/balance`, {}, admin);
  check('replayed payment did not double-charge', Math.abs(parseFloat(b3.body.balance)) < 0.001, b3.body.balance);

  const coClean = await call(`/reservations/${res2.body.id}/check-out`, { method: 'POST', body: '{}' }, fd);
  check('front desk can check out a settled stay with no override', coClean.status === 201 || coClean.status === 200,
    `status=${coClean.status}`);
  check('settled checkout is not flagged as overridden', coClean.body?.overridden === false);

  // ---------- extend ----------
  const res3 = await book(rooms[2].id);
  await call(`/reservations/${res3.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);

  const badExtend = await call(`/reservations/${res3.body.id}/extend`, {
    method: 'POST', body: JSON.stringify({ newCheckOutDate: addDays(ci, -1) }),
  }, fd);
  check('extending to an earlier date is rejected (400)', badExtend.status === 400, `status=${badExtend.status}`);

  const goodExtend = await call(`/reservations/${res3.body.id}/extend`, {
    method: 'POST', body: JSON.stringify({ newCheckOutDate: addDays(ci, 4) }),
  }, fd);
  check('extending later succeeds', goodExtend.status === 201 || goodExtend.status === 200, `status=${goodExtend.status}`);
  check('extra nights were claimed', goodExtend.body?.addedNights === 2, `${goodExtend.body?.addedNights}`);

  const nights = await q(
    `SELECT count(*)::int AS n FROM "RoomNightInventory" WHERE "reservationRoomId" =
       (SELECT id FROM "ReservationRoom" WHERE "reservationId" = $1)`, [res3.body.id]);
  check('allocation now covers 4 nights', nights.rows[0].n === 4, `${nights.rows[0].n}`);

  // ---------- reads ----------
  const arrivals = await call('/front-desk/arrivals', {}, fd);
  check('arrivals returns the business date', arrivals.body?.businessDate === today, arrivals.body?.businessDate);
  check('arrivals includes a room-readiness flag',
    Array.isArray(arrivals.body?.data) && arrivals.body.data.every((r: any) => typeof r.roomReady === 'boolean'));

  const inHouse = await call('/front-desk/in-house', {}, fd);
  check('in-house lists the extended stay', inHouse.body?.data?.some((r: any) => r.id === res3.body.id));

  const departures = await call('/front-desk/departures', {}, fd);
  check('departures entries carry a balance', departures.body?.data?.every((r: any) => 'balance' in r) !== false);

  // ---------- role denial ----------
  const hk = await login('housekeeping@dev.local');
  const hkArrivals = await call('/front-desk/arrivals', {}, hk);
  check('housekeeping cannot read arrivals (403)', hkArrivals.status === 403, `status=${hkArrivals.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  // cleanupPool is owned by the imported module; both must close or the
  // process hangs instead of exiting.
  .finally(async () => { await pool.end(); await cleanupPool.end(); });