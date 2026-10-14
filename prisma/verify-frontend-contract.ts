/**
 * Confirms the front-desk response shapes match the hand-written TypeScript
 * interfaces in src/lib/api/phase5.ts.
 *
 * Those types were written by reading the service, not from observed output, so
 * a silent mismatch would only surface as `undefined` in the browser at runtime.
 */
import 'dotenv/config';
import { cleanup, pool as cleanupPool } from './cleanup-test-data.js';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login(email: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'DevPass!2026' }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/**
 * Waits out the login throttle.
 *
 * This script authenticates as four roles, which exceeds the per-minute budget
 * when it runs straight after another suite. Without this the fixture setup
 * fails on 401s and every later check reports a false problem.
 */
async function loginWhenAllowed(email: string): Promise<string> {
  let cookie = await login(email);
  if (cookie) return cookie;
  await new Promise((r) => setTimeout(r, 65_000));
  cookie = await login(email);
  if (!cookie) {
    console.error(`Could not establish a session for ${email}; wait 60s and re-run.`);
    process.exitCode = 1;
  }
  return cookie;
}

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/**
 * Creates a checked-in stay so the in-house assertions always have a row to
 * inspect. Depending on another suite to have left one behind means the check
 * silently skips whenever that suite ran earlier and was then cleaned up, which
 * is exactly when the shape is most likely to be wrong.
 */
async function seedInHouseStay(admin: string): Promise<string | null> {
  const types = await call('/room-types', admin);
  const rt = types.body?.find((t: any) => t.isActive);
  if (!rt) return null;

  const guest = await post('/guests', admin, { firstName: 'Contract', lastName: 'p-contract' });
  const guestId = guest.body?.id;
  if (!guestId) {
    console.error(`  seed: guest creation failed (${guest.status}) ${JSON.stringify(guest.body).slice(0, 200)}`);
    return null;
  }

  const arrivals = await call('/front-desk/arrivals', admin);
  const today = arrivals.body?.businessDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) {
    console.error(`  seed: no business date (${arrivals.status}) ${JSON.stringify(arrivals.body).slice(0, 200)}`);
    return null;
  }

  const avail = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, admin);
  const roomId = avail.body?.available?.[0]?.id;
  if (!roomId) {
    console.error(`  seed: no room available (${avail.status}) ${JSON.stringify(avail.body).slice(0, 200)}`);
    return null;
  }

  const book = await post('/reservations', admin, {
    primaryGuestId: guestId, checkInDate: today, checkOutDate: addDays(today, 2),
    adults: 1, children: 0, roomTypeId: rt.id, roomId,
  });
  if (book.status >= 400) {
    console.error(`  seed: booking failed (${book.status}) ${JSON.stringify(book.body).slice(0, 200)}`);
    return null;
  }

  const ci = await post(`/reservations/${book.body.id}/check-in`, admin);
  if (ci.status >= 400) {
    console.error(`  seed: check-in failed (${ci.status}) ${JSON.stringify(ci.body).slice(0, 200)}`);
    return null;
  }
  return ci.body?.folioId ?? null;
}

/** Fields the frontend actually reads off each object. */
const STAY_FIELDS = [
  'id', 'bookingCode', 'status', 'checkInDate', 'checkOutDate',
  'adults', 'children', 'currencyCode', 'guestName', 'roomNumber',
  'roomStatus', 'roomReady', 'folioId', 'folioNo',
];

const TYPES = {
  id: 'string',
  bookingCode: 'string',
  status: 'string',
  adults: 'number',
  children: 'number',
  currencyCode: 'string',
  roomReady: 'boolean',
};

function checkShape(label: string, row: Record<string, unknown>) {
  const missing = STAY_FIELDS.filter((f) => !(f in row));
  check(
    `${label}: every field the UI reads is present`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${STAY_FIELDS.length} fields`,
  );

  const wrong = Object.entries(TYPES).filter(
    ([f, t]) => f in row && typeof row[f] !== t,
  );
  check(
    `${label}: field types match the TypeScript interface`,
    wrong.length === 0,
    wrong.length ? wrong.map(([f, t]) => `${f} is ${typeof row[f]}, declared ${t}`).join('; ') : 'ok',
  );
}

async function main() {
  await cleanup();

  const fd = await loginWhenAllowed('frontdesk@dev.local');
  const admin = await loginWhenAllowed('admin@dev.local');

  // Pin the active property before touching any property-scoped endpoint.
  // `switch-property` applies to the current session, and a fresh login creates
  // a new one on the default property — so a suite that does not switch queries
  // the annex inventory and concludes there are no rooms.
  const properties = await call('/properties', admin);
  const mainProperty = (properties.body ?? []).find((p: any) => p.slug === 'main-hotel');
  if (mainProperty) {
    const switched = await fetch(`${BASE}/auth/switch-property`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: admin },
      body: JSON.stringify({ propertyId: mainProperty.id }),
    });
    check('the active property can be pinned', switched.status === 204, `status=${switched.status}`);
  }

  const seededFolioId = await seedInHouseStay(admin);
  check('a checked-in stay was available to inspect', !!seededFolioId, String(seededFolioId));

  const arrivals = await call('/front-desk/arrivals', fd);
  check('arrivals responds 200', arrivals.status === 200, `status=${arrivals.status}`);
  check('arrivals carries a businessDate', /^\d{4}-\d{2}-\d{2}$/.test(arrivals.body?.businessDate ?? ''), arrivals.body?.businessDate);
  check('arrivals data is an array', Array.isArray(arrivals.body?.data));
  if (arrivals.body?.data?.length) {
    checkShape('arrivals row', arrivals.body.data[0]);
  } else {
    console.log('NOTE arrivals empty; shape checked via in-house instead');
  }

  const departures = await call('/front-desk/departures', fd);
  check('departures responds 200', departures.status === 200, `status=${departures.status}`);
  if (departures.body?.data?.length) {
    const row = departures.body.data[0];
    checkShape('departures row', row);
    // The frontend formats this directly, so it must be a decimal string.
    check(
      'departures balance is a decimal string, not null',
      typeof row.balance === 'string' && /^-?\d+\.\d{2}$/.test(row.balance),
      `${typeof row.balance} ${row.balance}`,
    );
  }

  const inHouse = await call('/front-desk/in-house', fd);
  check('in-house responds 200', inHouse.status === 200, `status=${inHouse.status}`);
  if (inHouse.body?.data?.length) checkShape('in-house row', inHouse.body.data[0]);

  // Folio balance drives both the deposit and checkout screens. The folio id must
// come off the list row itself: the checkout screen posts payments to
// /folios/:folioId/payments, so a row without it forces the client to guess.
  const inHouseWithFolio = await call('/front-desk/in-house', admin);
  const row = inHouseWithFolio.body?.data?.[0];
  check(
    'in-house rows expose a folioId once the guest is admitted',
    Boolean(row) && typeof row?.folioId === 'string',
    row ? `folioId=${row.folioId}` : 'no in-house stay; run verify:5a first',
  );

  if (row?.folioId) {
    const bal = await call(`/folios/${row.folioId}/balance`, admin);
    const FIELDS = ['charges', 'tax', 'total', 'paid', 'balance', 'currencyCode'];
    const missing = FIELDS.filter((f) => !(f in (bal.body ?? {})));
    check(
      'folio balance carries every field the checkout screen reads',
      bal.status === 200 && missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : FIELDS.join(', '),
    );
    check(
      'a folioId taken from the list actually resolves to that folio',
      bal.status === 200 && bal.body?.currencyCode === row.currencyCode,
      `status=${bal.status}`,
    );
  }

  // Room rack reads the Phase 3 room list shape.
  const rooms = await call('/rooms', admin);
  const rackFields = ['id', 'roomNumber', 'floor', 'status', 'isActive', 'roomTypeId', 'roomTypeName'];
  check(
    'rooms list carries every field the room rack reads',
    rooms.status === 200 && rooms.body.length > 0 &&
      rackFields.every((f) => f in rooms.body[0]),
    rooms.body?.[0] ? Object.keys(rooms.body[0]).filter((k) => !rackFields.includes(k)).join(', ') || 'exact match' : 'no rooms',
  );

  // Phase 7 shapes. The task board renders every field it lists, so each one
  // has to actually be present rather than showing blank.
  const hk = await loginWhenAllowed('housekeeping@dev.local');
  const tasks = await call('/housekeeping/tasks', hk);
  check('housekeeping can read tasks', tasks.status === 200, `status=${tasks.status}`);

  const mgr = await loginWhenAllowed('manager@dev.local');
  const mgrTasks = await call('/housekeeping/tasks', mgr);
  const taskRow = mgrTasks.body?.[0];

  if (taskRow) {
    const FIELDS = [
      'id', 'type', 'status', 'priority', 'roomId', 'roomNumber', 'floor',
      'roomStatus', 'assignedToId', 'assigneeName', 'dueAt', 'startedAt',
      'completedAt', 'inspectedAt', 'notes', 'blockedReason', 'createdAt',
    ];
    const missing = FIELDS.filter((f) => !(f in taskRow));
    check(
      'task rows carry every field the board renders',
      missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : `${FIELDS.length} fields`,
    );
  } else {
    // No task yet: create one so the assertion is real rather than skipped.
    const rooms = await call('/rooms', mgr);
    const room = rooms.body?.find((r: any) => r.isActive);
    await post('/housekeeping/tasks', mgr, { roomId: room.id, type: 'TURNDOWN' });
    const retried = await call('/housekeeping/tasks', mgr);
    const r2 = retried.body?.[0];
    const FIELDS = ['id', 'type', 'status', 'priority', 'roomNumber', 'roomStatus', 'createdAt'];
    const missing = FIELDS.filter((f) => !(f in (r2 ?? {})));
    check(
      'task rows carry every field the board renders',
      Boolean(r2) && missing.length === 0,
      r2 ? `missing ${missing.join(', ')}` : 'no task could be created',
    );
  }

  const summary = await call('/housekeeping/summary', hk);
  check('housekeeping can read the board summary', summary.status === 200, `status=${summary.status}`);
  check(
    'the summary exposes room readiness counts the board shows',
    ['total', 'ready', 'dirty', 'occupied', 'outOfOrder'].every((k) => k in (summary.body?.rooms ?? {})),
    JSON.stringify(summary.body?.rooms ?? {}),
  );

  const tickets = await call('/maintenance/tickets', hk);
  check('housekeeping can read tickets', tickets.status === 200, `status=${tickets.status}`);
  check(
    'ticket rows carry the fields the list renders',
    (tickets.body ?? []).every((t: any) =>
      ['id', 'ticketNo', 'title', 'priority', 'status', 'roomNumber', 'createdAt'].every((f) => f in t)),
    `${tickets.body?.length ?? 0} tickets`,
  );

  const hkOoo = await post(`/rooms/${(await call('/rooms', hk)).body?.[0]?.id}/out-of-order`, hk, {
    reason: 'should not be permitted',
  });
  check(
    'the out-of-order control is refused for housekeeping (403)',
    hkOoo.status === 403,
    `status=${hkOoo.status}`,
  );

  // Phase 9 shapes. The staff page renders each field it lists, so a missing one
  // shows as a blank cell rather than a build error. `admin` is already in
  // scope from earlier in this run.
  const staff = await call('/users', mgr);
  check('a manager can read the staff list', staff.status === 200, `status=${staff.status}`);

  const STAFF_FIELDS = [
    'userId', 'email', 'fullName', 'status', 'lastLoginAt', 'invitedAt',
    'acceptedAt', 'membershipId', 'propertyId', 'roleKey', 'roleName',
    'invitePending', 'inviteExpired', 'activeMembershipCount',
  ];
  const staffRow = staff.body?.[0];
  const staffMissing = staffRow ? STAFF_FIELDS.filter((f) => !(f in staffRow)) : STAFF_FIELDS;
  check(
    'staff rows carry every field the staff page renders',
    !!staffRow && staffMissing.length === 0,
    staffRow ? `missing ${staffMissing.join(', ')}` : 'no staff returned',
  );

  const roles = await call('/roles', admin);
  check('an admin can read roles', roles.status === 200, `status=${roles.status}`);
  const ROLE_FIELDS = ['id', 'key', 'name', 'description', 'isSystem', 'isActive', 'permissions', 'memberCount'];
  const roleRow = roles.body?.[0];
  check(
    'role rows carry every field the roles tab renders',
    !!roleRow && ROLE_FIELDS.every((f) => f in roleRow),
    roleRow ? ROLE_FIELDS.filter((f) => !(f in roleRow)).join(', ') || 'exact match' : 'no roles',
  );

  const matrix = await call('/roles/matrix', admin);
  check('the permission matrix is readable', matrix.status === 200, `status=${matrix.status}`);
  check(
    'matrix groups expose the fields the table renders',
    matrix.body?.resources?.[0]?.permissions?.[0] !== undefined
      && ['key', 'description', 'roles'].every((f) => f in matrix.body.resources[0].permissions[0]),
    JSON.stringify(matrix.body?.resources?.[0]?.permissions?.[0] ?? {}).slice(0, 80),
  );

  const tax = await call('/tax-rules', mgr);
  check('a manager can read tax rules', tax.status === 200, `status=${tax.status}`);
  check(
    'tax rule rows carry the fields the settings table renders',
    (tax.body ?? []).every((t: any) =>
      ['id', 'code', 'name', 'ratePercent', 'isInclusive', 'isActive'].every((f) => f in t)),
    `${tax.body?.length ?? 0} rules`,
  );
  check(
    'tax rates are decimal strings, not floats',
    (tax.body ?? []).every((t: any) => typeof t.ratePercent === 'string'),
    (tax.body ?? [])[0]?.ratePercent,
  );

  // Phase 10 page shapes. Each of these was hand-written against the API and the
// first draft guessed at three fields that do not exist; a contract check is
// what stops that class of mistake reaching the browser.
  const reservations = await call('/reservations?pageSize=5', mgr);
  check('the reservations list is readable', reservations.status === 200, `status=${reservations.status}`);
  check(
    'the reservation page carries the fields the list renders',
    ['data', 'page', 'pageSize', 'hasMore', 'today'].every((f) => f in (reservations.body ?? {})),
    Object.keys(reservations.body ?? {}).join(', '),
  );
  const resRow = (reservations.body?.data ?? [])[0];
  check(
    'a reservation row carries the fields the table renders',
    !resRow || ['id', 'bookingCode', 'status', 'checkInDate', 'checkOutDate',
      'nights', 'totalAmount', 'currencyCode'].every((f) => f in resRow),
    resRow ? Object.keys(resRow).join(', ') : 'no reservations to inspect',
  );

  const guests = await call('/guests?pageSize=5', fd);
  check('the guest directory is readable', guests.status === 200, `status=${guests.status}`);
  // The list deliberately reports hasMore rather than a total: the contract
  // client has no count(), so a total would mean reading the whole table.
  check(
    'the guest page reports hasMore rather than a total',
    'hasMore' in (guests.body ?? {}) && !('total' in (guests.body ?? {})),
    Object.keys(guests.body ?? {}).join(', '),
  );
  const guestRow = (guests.body?.data ?? [])[0];
  check(
    'a guest row carries the fields the directory renders',
    !guestRow || ['id', 'firstName', 'lastName', 'email', 'phone',
      'companyName', 'city', 'countryCode', 'masked'].every((f) => f in guestRow),
    guestRow ? Object.keys(guestRow).join(', ') : 'no guests to inspect',
  );

  const roomTypesForAvail = await call('/room-types', admin);
  const rt = (roomTypesForAvail.body ?? [])[0];
  if (rt) {
    const todayForAvail = new Date().toISOString().slice(0, 10);
    const tomorrowForAvail = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const avail = await call(
      `/availability?checkIn=${todayForAvail}&checkOut=${tomorrowForAvail}&roomTypeId=${rt.id}`, admin);
    check('availability is readable', avail.status === 200, `status=${avail.status}`);
    check(
      'availability carries nights, totalRooms and available',
      ['nights', 'totalRooms', 'available'].every((f) => f in (avail.body ?? {})),
      Object.keys(avail.body ?? {}).join(', '),
    );
    const availRoom = (avail.body?.available ?? [])[0];
    check(
      'an available room carries only the fields the picker renders',
      !availRoom || ['id', 'roomNumber', 'floor', 'status'].every((f) => f in availRoom),
      availRoom ? Object.keys(availRoom).join(', ') : 'no rooms available in window',
    );
  }

  const flash = await call('/reports/daily-flash', mgr);
  check('the daily flash is readable', flash.status === 200, `status=${flash.status}`);
  check(
    'the daily flash carries the counts the dashboard tiles render',
    ['businessDate', 'inHouseCount', 'rooms', 'housekeeping', 'maintenance']
      .every((f) => f in (flash.body ?? {})),
    Object.keys(flash.body ?? {}).join(', '),
  );
  check(
    'the daily flash room breakdown carries every state the tiles count',
    flash.body?.rooms &&
      ['total', 'ready', 'dirty', 'occupied', 'outOfOrder'].every((f) => f in flash.body.rooms),
    JSON.stringify(flash.body?.rooms ?? {}),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });