/** Phase 3 backend checks: property settings, inventory CRUD, theme prefs. */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

/**
 * Removes fixtures from any previous run so the suite is repeatable. This uses
 * direct SQL deliberately: the API has no delete route for rooms or room types,
 * by design, because real records must not disappear.
 */
async function cleanupFixtures() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM "Room" WHERE "roomNumber" = 'T-01'`);
    await c.query(
      `DELETE FROM "RoomType" WHERE code = 'TST'
         AND id NOT IN (SELECT "roomTypeId" FROM "Room")`,
    );
    // Remove saved theme choices so the "default is Luxury Beige & Taupe"
    // assertion is meaningful on a repeat run.
    await c.query(`DELETE FROM "UserThemePreference"`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

import { pinProperty } from './cleanup-test-data.js';
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') };
}

const cookieOf = (c: string | null) => c?.split(';')[0] ?? '';

async function login(email: string) {
  const r = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return cookieOf(r.setCookie);
}

async function main() {
  await cleanupFixtures();
  const admin = await login('admin@dev.local');
  await pinProperty(admin);
  const hk = await login('housekeeping@dev.local');

  // ---- properties ----
  const props = await call('/properties', { headers: { cookie: admin } });
  check('GET /properties returns 200', props.status === 200, `status=${props.status}`);
  check('admin sees 2 properties', props.body?.length === 2, `${props.body?.length}`);
  check(
    'each property carries the role held at that property',
    props.body?.every((p: any) => p.role?.key === 'ADMIN'),
  );

  const mainProp = props.body?.find((p: any) => p.slug === 'main-hotel');
  check('main-hotel is present', !!mainProp, mainProp?.name);

  // update
  const patch = await call(`/properties/${mainProp.id}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ checkInTime: '15:00', checkOutTime: '11:00' }),
  });
  check('PATCH property succeeds for admin', patch.status === 200, `status=${patch.status}`);
  check('check-in time persisted', patch.body?.checkInTime === '15:00', String(patch.body?.checkInTime));

  // invalid time format rejected
  const badTime = await call(`/properties/${mainProp.id}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ checkInTime: '25:99' }),
  });
  check('out-of-range time 25:99 is rejected with 400', badTime.status === 400, `status=${badTime.status}`);

  // unknown field rejected (allow-list)
  const badField = await call(`/properties/${mainProp.id}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ organizationId: 'hijack' }),
  });
  check('unknown field is rejected (400, no mass assignment)', badField.status === 400, `status=${badField.status}`);

  // ---- role denial ----
  // The kit's HOUSEKEEPING role deliberately has no `property.read`, so a 403
  // here is the intended behaviour, not a bug.
  const hkProps = await call('/properties', { headers: { cookie: hk } });
  check(
    'housekeeping is denied property.read (kit grants it no such key)',
    hkProps.status === 403,
    `status=${hkProps.status}`,
  );

  const hkPatch = await call(`/properties/${mainProp.id}`, {
    method: 'PATCH',
    headers: { cookie: hk },
    body: JSON.stringify({ checkInTime: '14:00' }),
  });
  check(
    'housekeeping cannot update property settings (403)',
    hkPatch.status === 403,
    `status=${hkPatch.status}`,
  );

  // ---- cross-property edit blocked ----
  const annex = props.body?.find((p: any) => p.slug === 'annex-property');
  await call('/auth/switch-property', {
    method: 'POST',
    headers: { cookie: admin },
    body: JSON.stringify({ propertyId: annex.id }),
  });
  const crossEdit = await call(`/properties/${mainProp.id}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ checkInTime: '14:00' }),
  });
  check(
    'cannot edit a property that is not the active one',
    crossEdit.body?.notFound === true,
    JSON.stringify(crossEdit.body),
  );
  await call('/auth/switch-property', {
    method: 'POST',
    headers: { cookie: admin },
    body: JSON.stringify({ propertyId: mainProp.id }),
  });

  // ---- room types ----
  const rt = await call('/room-types', { headers: { cookie: admin } });
  check('GET /room-types returns 200', rt.status === 200, `status=${rt.status}`);
  check('5 seeded room types present', rt.body?.length === 5, `${rt.body?.length}`);

  const created = await call('/room-types', {
    method: 'POST',
    headers: { cookie: admin },
    body: JSON.stringify({ code: 'tst', name: 'Test Suite', maxAdults: 3, baseRate: 9999 }),
  });
  check('POST /room-types creates', created.status === 201 || created.status === 200, `status=${created.status}`);
  const newId = created.body?.id;

  const afterCreate = await call('/room-types', { headers: { cookie: admin } });
  check('new room type appears in the list', afterCreate.body?.length === 6, `${afterCreate.body?.length}`);
  check(
    'code is normalised to uppercase',
    afterCreate.body?.find((r: any) => r.id === newId)?.code === 'TST',
  );

  const updatedRt = await call(`/room-types/${newId}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ baseRate: 10500, isActive: false }),
  });
  check('PATCH room type succeeds', updatedRt.status === 200, `status=${updatedRt.status}`);
  check('isActive=false persisted', updatedRt.body?.isActive === false);

  // ---- rooms ----
  const rooms = await call('/rooms', { headers: { cookie: admin } });
  check('GET /rooms returns 200', rooms.status === 200, `status=${rooms.status}`);
  check('20 seeded rooms present', rooms.body?.length === 20, `${rooms.body?.length}`);
  check(
    'each room is joined to its type code',
    rooms.body?.every((r: any) => typeof r.roomTypeCode === 'string'),
  );

  const newRoom = await call('/rooms', {
    method: 'POST',
    headers: { cookie: admin },
    body: JSON.stringify({ roomNumber: 'T-01', roomTypeId: newId, floor: 'Test' }),
  });
  check('POST /rooms creates', newRoom.status === 201 || newRoom.status === 200, `status=${newRoom.status}`);

  // room type from another property must be rejected
  const badRoom = await call('/rooms', {
    method: 'POST',
    headers: { cookie: admin },
    body: JSON.stringify({ roomNumber: 'T-02', roomTypeId: '00000000-0000-0000-0000-000000000000' }),
  });
  check(
    'room referencing an unknown room type is rejected',
    badRoom.body?.error === 'room_type_not_in_property',
    JSON.stringify(badRoom.body),
  );

  const roomsAfter = await call('/rooms', { headers: { cookie: admin } });
  check('room count grew by 1', roomsAfter.body?.length === 21, `${roomsAfter.body?.length}`);

  // retire rather than delete
  const retire = await call(`/rooms/${newRoom.body?.id}`, {
    method: 'PATCH',
    headers: { cookie: admin },
    body: JSON.stringify({ isActive: false }),
  });
  check('room can be retired (isActive=false)', retire.body?.isActive === false);

  const stillThere = await call('/rooms', { headers: { cookie: admin } });
  check(
    'retired room is still listed, not deleted',
    stillThere.body?.some((r: any) => r.id === newRoom.body?.id),
  );

  // ---- housekeeping denied writes ----
  const hkRooms = await call('/rooms', { headers: { cookie: hk } });
  check('housekeeping can read rooms', hkRooms.status === 200, `status=${hkRooms.status}`);
  const hkCreate = await call('/rooms', {
    method: 'POST',
    headers: { cookie: hk },
    body: JSON.stringify({ roomNumber: 'X-1', roomTypeId: newId }),
  });
  check('housekeeping cannot create rooms (403)', hkCreate.status === 403, `status=${hkCreate.status}`);

  // ---- theme preferences ----
  const themeGet = await call('/preferences/theme', { headers: { cookie: admin } });
  check('GET /preferences/theme returns 200', themeGet.status === 200, `status=${themeGet.status}`);
  check(
    'default theme is Luxury Beige & Taupe per the kit',
    themeGet.body?.themeKey === 'LUXURY_BEIGE_TAUPE',
    String(themeGet.body?.themeKey),
  );

  const themePut = await call('/preferences/theme', {
    method: 'PUT',
    headers: { cookie: admin },
    body: JSON.stringify({ themeKey: 'EUCALYPTUS' }),
  });
  check('PUT /preferences/theme accepts a valid key', themePut.body?.applied === true);

  const themeReadBack = await call('/preferences/theme', { headers: { cookie: admin } });
  check('theme persisted', themeReadBack.body?.themeKey === 'EUCALYPTUS', String(themeReadBack.body?.themeKey));

  const badTheme = await call('/preferences/theme', {
    method: 'PUT',
    headers: { cookie: admin },
    body: JSON.stringify({ themeKey: 'NEON_HAXX' }),
  });
  check('unknown theme key is rejected with 400', badTheme.status === 400, `status=${badTheme.status}`);

  const cssAttempt = await call('/preferences/theme', {
    method: 'PUT',
    headers: { cookie: admin },
    body: JSON.stringify({ themeKey: 'red; background: url(evil)' }),
  });
  check('arbitrary CSS value is rejected with 400', cssAttempt.status === 400, `status=${cssAttempt.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('error:', e);
  process.exitCode = 1;
});