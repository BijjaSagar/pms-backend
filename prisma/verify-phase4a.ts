/**
 * Phase 4A acceptance checks.
 *
 * The headline requirement is that two concurrent bookings for the same room and
 * night can never both succeed, so that case is fired with real parallel HTTP
 * requests rather than asserted from the database afterwards.
 */
import 'dotenv/config';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

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
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function login(email: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const marker = `p4a-${Date.now()}`;
// Far-future dates keep the fixture clear of anything a demo might create.
const CI = '2027-03-10';
const CO = '2027-03-12';

async function main() {
  // Self-cleaning: reservations from a previous run stay CONFIRMED and keep
  // holding nights, which starves this run of availability and produces failures
  // unrelated to the code.
  await cleanup();

  const admin = await login('admin@dev.local');
  const auditor = await login('auditor@dev.local');
  await pinProperty(admin);
  const hk = await login('housekeeping@dev.local');

  const roomsRes = await call('/rooms', {}, admin);
  const roomTypes = await call('/room-types', {}, admin);
  const roomType = roomTypes.body.find((t: any) => t.isActive);
  const room = roomsRes.body.find((r: any) => r.isActive);
  check('fixtures available', !!roomType && !!room, `${roomType?.code} / room ${room?.roomNumber}`);

  // ---------- guests ----------
  const g1 = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({
      firstName: 'Phase4', lastName: marker,
      email: `${marker}@example.test`, phone: '+919876543210', city: 'Pune',
    }),
  }, admin);
  check('POST /guests creates', g1.status === 201 || g1.status === 200, `status=${g1.status}`);
  const guestId = g1.body?.id;

  const gList = await call('/guests', {}, admin);
  check('GET /guests returns 200', gList.status === 200);
  check('list is paginated with hasMore, not a raw array', Array.isArray(gList.body?.data) && 'hasMore' in gList.body);
  check('created guest is searchable', JSON.stringify(gList.body).includes(marker));

  // ---------- PII shaping ----------
  const adminView = await call(`/guests/${guestId}`, {}, admin);
  check('admin sees full PII', adminView.body?.email === `${marker}@example.test`, String(adminView.body?.email));
  check('admin view is not masked', adminView.body?.masked === false);

  const audView = await call(`/guests/${guestId}`, {}, auditor);
  check('auditor has guest.read but not guest.pii.read', audView.status === 200, `status=${audView.status}`);
  check('auditor sees masked email', audView.body?.email !== `${marker}@example.test` && !!audView.body?.email, String(audView.body?.email));
  check('auditor view is flagged masked', audView.body?.masked === true);
  check('auditor gets no address/country', audView.body?.addressLine1 === null && audView.body?.countryCode === null);

  const hkGuest = await call(`/guests/${guestId}`, {}, hk);
  check('housekeeping is denied guest.read entirely', hkGuest.status === 403, `status=${hkGuest.status}`);

  // ---------- reservations ----------
  const noRoom = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: CI, checkOutDate: CO,
      adults: 2, children: 0, roomTypeId: roomType.id,
    }),
  }, admin);
  check('reservation can be created without a room', noRoom.status === 201 || noRoom.status === 200, `status=${noRoom.status}`);
  check('it reports no room assigned', noRoom.body?.roomAssigned === false);
  check('nights counted exclusively (2 for 10th-12th)', noRoom.body?.nights === 2, `${noRoom.body?.nights}`);
  check('rate snapshot written from RoomType.baseRate', Number(noRoom.body?.totalAmount) > 0, String(noRoom.body?.totalAmount));

  const badStay = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: CO, checkOutDate: CI,
      adults: 1, children: 0, roomTypeId: roomType.id,
    }),
  }, admin);
  check('check-out before check-in is rejected (400)', badStay.status === 400, `status=${badStay.status}`);

  const sameDay = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: CI, checkOutDate: CI,
      adults: 1, children: 0, roomTypeId: roomType.id,
    }),
  }, admin);
  check('same-day stay is rejected (400)', sameDay.status === 400, `status=${sameDay.status}`);

  // ---------- THE CONCURRENCY PROOF ----------
  const avail = await call(`/availability?checkIn=${CI}&checkOut=${CO}&roomTypeId=${roomType.id}`, {}, admin);
  check('availability returns nights', Array.isArray(avail.body?.nights) && avail.body.nights.length === 2, JSON.stringify(avail.body?.nights));
  check('checkout date is NOT among the consumed nights', !avail.body?.nights.includes(CO));

  const target = avail.body.available[0];
  check('at least one room is available', !!target, target?.roomNumber);

  const bookThisRoom = () =>
    call('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        primaryGuestId: guestId, checkInDate: CI, checkOutDate: CO,
        adults: 1, children: 0, roomTypeId: roomType.id, roomId: target.id,
      }),
    }, admin);

  // Five genuinely parallel attempts at the same room and nights.
  const race = await Promise.all([bookThisRoom(), bookThisRoom(), bookThisRoom(), bookThisRoom(), bookThisRoom()]);
  const created = race.filter((r) => r.status === 200 || r.status === 201);
  const conflicts = race.filter((r) => r.status === 409);
  check(
    'exactly one of five concurrent bookings succeeds',
    created.length === 1,
    `${created.length} created, ${conflicts.length} rejected 409, statuses=${race.map((r) => r.status).join(',')}`,
  );
  check('the losers are 409 Conflict', created.length === 1 && conflicts.length === 4);
  const winner = created[0]?.body;

  // ---------- allocation released on cancel ----------
  const availAfter = await call(`/availability?checkIn=${CI}&checkOut=${CO}&roomTypeId=${roomType.id}`, {}, admin);
  const stillListed = availAfter.body.available.find((r: any) => r.id === target.id);
  check('booked room is no longer offered for those nights', !stillListed);

  await call(`/reservations/${winner.id}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason: 'phase 4a verification cleanup' }),
  }, admin);
  const availAfterCancel = await call(`/availability?checkIn=${CI}&checkOut=${CO}&roomTypeId=${roomType.id}`, {}, admin);
  check(
    'cancelling releases the room back to availability',
    !!availAfterCancel.body.available.find((r: any) => r.id === target.id),
  );

  // ---------- cancellation requires a reason ----------
  const throwaway = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: CI, checkOutDate: CO,
      adults: 1, children: 0, roomTypeId: roomType.id,
    }),
  }, admin);
  const noReason = await call(`/reservations/${throwaway.body.id}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason: '' }),
  }, admin);
  check('cancelling without a reason is rejected (400)', noReason.status === 400, `status=${noReason.status}`);

  // ---------- status cannot be set generically ----------
  const patchStatus = await call(`/reservations/${throwaway.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'CHECKED_OUT' }),
  }, admin);
  check('PATCH cannot set status directly', patchStatus.status >= 400, `status=${patchStatus.status}`);

  // ---------- amend releases old nights ----------
  const amend = await call(`/reservations/${throwaway.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ checkInDate: '2027-04-10', checkOutDate: '2027-04-13' }),
  }, admin);
  check('amending dates succeeds', amend.status === 200, `status=${amend.status}`);
  check('night count recomputed (3)', amend.body?.nights === 3, `${amend.body?.nights}`);
  const oldAvail = await call(`/availability?checkIn=${CI}&checkOut=${CO}&roomTypeId=${roomType.id}`, {}, admin);
  check('original dates released after amendment', !!oldAvail.body.available.find((r: any) => r.id === target.id));

  // ---------- assign-room ----------
  const assignable = oldAvail.body.available.find((r: any) => r.id !== target.id)?.id ?? target.id;
  const assign = await call(`/reservations/${throwaway.body.id}/assign-room`, {
    method: 'POST', body: JSON.stringify({ roomId: assignable }),
  }, admin);
  check('assign-room succeeds', assign.status === 200 || assign.status === 201, `status=${assign.status}`);
  check('assign-room reports the nights claimed', assign.body?.nights === 3, `${assign.body?.nights}`);

  const detail = await call(`/reservations/${throwaway.body.id}`, {}, admin);
  check('detail shows the assigned room number', detail.body?.roomLines?.[0]?.roomNumber != null, String(detail.body?.roomLines?.[0]?.roomNumber));

  // ---------- role denial ----------
  const hkRes = await call('/reservations', {}, hk);
  check('housekeeping is denied reservation.read', hkRes.status === 403, `status=${hkRes.status}`);
  const audCreate = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: CI, checkOutDate: CO,
      adults: 1, children: 0, roomTypeId: roomType.id,
    }),
  }, auditor);
  check('auditor cannot create reservations', audCreate.status === 403, `status=${audCreate.status}`);

  // ---------- cross-property isolation ----------
  const props = await call('/properties', {}, admin);
  const annex = props.body.find((p: any) => p.slug === 'annex-property');
  await call('/auth/switch-property', {
    method: 'POST', body: JSON.stringify({ propertyId: annex.id }),
  }, admin);
  const leak = await call(`/reservations/${winner.id}`, {}, admin);
  check(
    'a reservation from the other property is not readable after switching',
    leak.status === 404,
    `status=${leak.status}`,
  );
  const leakCancel = await call(`/reservations/${winner.id}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason: 'cross-property attempt' }),
  }, admin);
  check('and cannot be cancelled from another property', leakCancel.status === 404, `status=${leakCancel.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('verification error:', e);
    process.exitCode = 1;
  })
  // cleanupPool belongs to the imported module; both pools must close or the
  // process hangs instead of exiting.
  .finally(async () => { await cleanupPool.end(); });