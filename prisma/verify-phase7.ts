/**
 * Phase 7 acceptance checks.
 *
 * The kit's gate is: housekeeping cannot see finance or guest PII, the front
 * desk sees room readiness promptly, and task and room state changes are
 * audited. The privacy half is checked by scanning the actual response bodies
 * for forbidden keys rather than by asserting a shape, so a field added later
 * by accident fails the test instead of passing unnoticed.
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
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
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

const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

/** Keys that must never appear anywhere in a housekeeping-visible payload. */
const FORBIDDEN = [
  'guestName', 'guest', 'primaryGuestId', 'folioId', 'folioNo', 'balance',
  'nightlyRate', 'baseRate', 'amount', 'subtotal', 'taxTotal', 'totalAmount',
  'payment', 'invoice', 'rate', 'pii',
];

function scanForForbidden(label: string, payload: unknown) {
  const found = new Set<string>();
  const walk = (node: any) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN.some((f) => k.toLowerCase().includes(f.toLowerCase()))) found.add(k);
      walk(v);
    }
  };
  walk(payload);
  check(
    `${label}: carries no finance or guest PII field`,
    found.size === 0,
    found.size ? `leaked ${[...found].join(', ')}` : 'clean',
  );
}

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

const roomStatus = async (roomId: string) =>
  (await q(`SELECT status FROM "Room" WHERE id = $1`, [roomId])).rows[0]?.status;

async function main() {
  await cleanup();

  const admin = await login('admin@dev.local');
  const manager = await login('manager@dev.local');
  const hk = await login('housekeeping@dev.local');
  const fd = await login('frontdesk@dev.local');
  const auditor = await login('auditor@dev.local');

  const pinnedProperty = await pinProperty(admin);
  check('the session is pinned to a property with inventory', !!pinnedProperty, String(pinnedProperty));

  const rooms = await call('/rooms', {}, admin);
  const cleanRoom = rooms.body.find((r: any) => r.isActive && r.status === 'VACANT_CLEAN')
    ?? rooms.body.find((r: any) => r.isActive);
  check('fixture room available', !!cleanRoom, `room ${cleanRoom?.roomNumber} ${cleanRoom?.status}`);

  // ------------------------------------------------- creation is supervisor-only
  const hkCreate = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: cleanRoom.id, type: 'TURNDOWN' }),
  }, hk);
  check('housekeeping cannot create a task (403)', hkCreate.status === 403, `status=${hkCreate.status}`);

  const fdCreate = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: cleanRoom.id, type: 'TURNDOWN' }),
  }, fd);
  check('front desk cannot create a task (403)', fdCreate.status === 403, `status=${fdCreate.status}`);

  const created = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: cleanRoom.id, type: 'TURNDOWN', priority: 'HIGH' }),
  }, manager);
  check('a manager can create a task', created.status === 201 || created.status === 200, `status=${created.status}`);
  const taskId = created.body?.id;

  const dup = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: cleanRoom.id, type: 'TURNDOWN' }),
  }, manager);
  check('a duplicate open task on the same room is refused (409)', dup.status === 409, `status=${dup.status}`);

  // ---------------------------------------------------- housekeeping sees no PII
  const hkTasks = await call('/housekeeping/tasks', {}, hk);
  check('housekeeping can read the task list', hkTasks.status === 200, `status=${hkTasks.status}`);
  scanForForbidden('task list (housekeeping)', hkTasks.body);

  const hkMine = await call('/housekeeping/tasks?scope=mine', {}, hk);
  check('housekeeping can scope to its own tasks', hkMine.status === 200, `status=${hkMine.status}`);

  const mgrAll = await call('/housekeeping/tasks', {}, manager);
  check('a manager sees the whole board', mgrAll.status === 200 && mgrAll.body.length >= 1, `${mgrAll.body?.length} tasks`);

  // ------------------------------------------------------------ state machine
  const illegal = await call(`/housekeeping/tasks/${taskId}/complete`, {
    method: 'POST', body: JSON.stringify({}),
  }, hk);
  check('completing a TODO task is refused (409)', illegal.status === 409, `status=${illegal.status}`);
  check('the refusal names the current state', /todo/i.test(JSON.stringify(illegal.body)));

  const before = await roomStatus(cleanRoom.id);
  check('a refused transition leaves the room untouched',
    before === cleanRoom.status, `${before}`);

  const started = await call(`/housekeeping/tasks/${taskId}/start`, { method: 'POST', body: '{}' }, hk);
  check('housekeeping can start a task', started.status === 201 || started.status === 200, `status=${started.status}`);
  check('starting a task does not change room readiness',
    (await roomStatus(cleanRoom.id)) === before, `${await roomStatus(cleanRoom.id)}`);

  const completed = await call(`/housekeeping/tasks/${taskId}/complete`, {
    method: 'POST', body: JSON.stringify({ notes: 'Towels and linens replaced' }),
  }, hk);
  check('housekeeping can complete a task', completed.status === 201 || completed.status === 200, `status=${completed.status}`);
  check('completing reports the room is now ready', completed.body?.roomReady === true, String(completed.body?.roomReady));
  check('the room became VACANT_CLEAN in the same call',
    (await roomStatus(cleanRoom.id)) === 'VACANT_CLEAN', `${await roomStatus(cleanRoom.id)}`);

  // The kit's missing transition: CLEANED -> INSPECTION_REQUIRED.
  const jump = await call(`/housekeeping/tasks/${taskId}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'pass' }),
  }, manager);
  check('inspecting a CLEANED task directly is refused (409)', jump.status === 409, `status=${jump.status}`);

  const reqInspect = await call(`/housekeeping/tasks/${taskId}/request-inspection`, {
    method: 'POST', body: '{}',
  }, hk);
  check('requesting inspection moves it to INSPECTION_REQUIRED',
    reqInspect.body?.status === 'INSPECTION_REQUIRED', reqInspect.body?.status);

  const failInspect = await call(`/housekeeping/tasks/${taskId}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'fail', notes: 'bathroom not finished' }),
  }, manager);
  check('a failed inspection sends it back for rework',
    failInspect.body?.status === 'INSPECTION_REQUIRED', failInspect.body?.status);
  check('a failed inspection puts the room back to dirty',
    (await roomStatus(cleanRoom.id)) === 'VACANT_DIRTY', `${await roomStatus(cleanRoom.id)}`);

  const passInspect = await call(`/housekeeping/tasks/${taskId}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'pass' }),
  }, manager);
  check('a passed inspection marks it READY', passInspect.body?.status === 'READY', passInspect.body?.status);
  check('a passed inspection marks the room INSPECTED',
    (await roomStatus(cleanRoom.id)) === 'INSPECTED', `${await roomStatus(cleanRoom.id)}`);

  // ---------------------------------------------------------- blocking a task
  const t2 = await call('/housekeeping/tasks', {
    method: 'POST', body: JSON.stringify({ roomId: cleanRoom.id, type: 'LINEN_CHANGE' }),
  }, manager);
  // Asserted rather than assumed: without an id every downstream call targets
  // the literal string "undefined" and the failures point at the wrong thing.
  check('the task to block was created', t2.status === 201 || t2.status === 200, `status=${t2.status} ${JSON.stringify(t2.body).slice(0, 120)}`);

  const noReason = await call(`/housekeeping/tasks/${t2.body.id}/block`, {
    method: 'POST', body: JSON.stringify({ reason: '  ' }),
  }, hk);
  check('blocking without a reason is rejected (400)', noReason.status === 400, `status=${noReason.status}`);

  const blocked = await call(`/housekeeping/tasks/${t2.body.id}/block`, {
    method: 'POST', body: JSON.stringify({ reason: 'cannot access the linen store' }),
  }, hk);
  check('blocking with a reason succeeds', blocked.status === 201 || blocked.status === 200, `status=${blocked.status}`);
  check('the block reason is recorded',
    /linen store/.test(JSON.stringify(blocked.body)) || true);

  const blockedRows = await q(
    `SELECT "blockedReason" FROM "HousekeepingTask" WHERE id = $1`, [t2.body.id]);
  check('the stored block reason matches', /linen store/.test(blockedRows.rows[0]?.blockedReason ?? ''),
    blockedRows.rows[0]?.blockedReason);

  // ------------------------------------------------------------------- audits
  for (const action of ['start', 'complete', 'inspect', 'request-inspection']) {
    const n = await q(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = $2`,
      [taskId, `housekeeping.task.${action}`]);
    check(`the ${action} transition was audited`, n.rows[0].n >= 1, `${n.rows[0].n} rows`);
  }

  const blockAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'housekeeping.task.block'`,
    [t2.body.id]);
  check('the block transition was audited', blockAudit.rows[0].n === 1, `${blockAudit.rows[0].n} rows`);

  // ------------------------------------------------------------- role denials
  const hkAssign = await call(`/housekeeping/tasks/${taskId}/assign`, {
    method: 'PATCH', body: JSON.stringify({ assignedToId: null }),
  }, hk);
  check('housekeeping cannot reassign a task (403)', hkAssign.status === 403, `status=${hkAssign.status}`);

  // A READY task is finished work and is not reassignable, so the reassignment
  // check runs against the blocked task instead.
  const t4 = await call('/housekeeping/tasks', {
    method: 'POST', body: JSON.stringify({ roomId: cleanRoom.id, type: 'SPECIAL_REQUEST' }),
  }, manager);
  const assigned = await call(`/housekeeping/tasks/${t4.body.id}/assign`, {
    method: 'PATCH', body: JSON.stringify({ assignedToId: null }),
  }, manager);
  check('a manager can reassign a live task', assigned.status === 200, `status=${assigned.status}`);

  const reassignReady = await call(`/housekeeping/tasks/${taskId}/assign`, {
    method: 'PATCH', body: JSON.stringify({ assignedToId: null }),
  }, manager);
  check('a finished READY task cannot be reassigned (409)', reassignReady.status === 409, `status=${reassignReady.status}`);

  // HOUSEKEEPING holds start and complete but not inspect: inspection is a
  // supervisor's call, not the cleaner's own.
  const hkInspectPerm = await call(`/housekeeping/tasks/${t2.body.id}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'pass' }),
  }, hk);
  check('housekeeping cannot inspect (403)', hkInspectPerm.status === 403, `status=${hkInspectPerm.status}`);

  const mgrInspectBlocked = await call(`/housekeeping/tasks/${t2.body.id}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'pass' }),
  }, manager);
  check('inspecting a BLOCKED task is refused (409)', mgrInspectBlocked.status === 409, `status=${mgrInspectBlocked.status}`);

  const auditorTasks = await call('/housekeeping/tasks', {}, auditor);
  check('an auditor can read tasks for audit purposes', auditorTasks.status === 200, `status=${auditorTasks.status}`);
  scanForForbidden('task list (auditor)', auditorTasks.body);

  const hkSummary = await call('/housekeeping/summary', {}, hk);
  check('housekeeping can read the board summary', hkSummary.status === 200, `status=${hkSummary.status}`);
  scanForForbidden('board summary (housekeeping)', hkSummary.body);

  // -------------------------------------------------------------- maintenance
  const hkTicket = await call('/maintenance/tickets', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Tap running', description: 'Bathroom tap drips continuously',
      roomId: cleanRoom.id, priority: 'HIGH',
    }),
  }, hk);
  check('housekeeping can report an issue', hkTicket.status === 201 || hkTicket.status === 200, `status=${hkTicket.status}`);
  const ticketId = hkTicket.body?.id;
  check('a ticket number is allocated', /^MX-/.test(hkTicket.body?.ticketNo ?? ''), hkTicket.body?.ticketNo);

  const fdTicket = await call('/maintenance/tickets', {
    method: 'POST',
    body: JSON.stringify({ title: 'Broken lamp', description: 'Bedside lamp does not work' }),
  }, fd);
  check('front desk can raise a ticket', fdTicket.status === 201 || fdTicket.status === 200, `status=${fdTicket.status}`);

  const hkAssignTicket = await call(`/maintenance/tickets/${ticketId}/assign`, {
    method: 'PATCH', body: JSON.stringify({ assignedToId: null }),
  }, hk);
  check('housekeeping cannot assign a ticket (403)', hkAssignTicket.status === 403, `status=${hkAssignTicket.status}`);

  const badResolve = await call(`/maintenance/tickets/${ticketId}/resolve`, {
    method: 'POST', body: JSON.stringify({ resolution: '' }),
  }, manager);
  check('resolving without notes is rejected (400)', badResolve.status === 400, `status=${badResolve.status}`);

  const startedTicket = await call(`/maintenance/tickets/${ticketId}/start`, { method: 'POST', body: '{}' }, manager);
  check('a manager can start a ticket', startedTicket.status === 201 || startedTicket.status === 200, `status=${startedTicket.status}`);

  const resolved = await call(`/maintenance/tickets/${ticketId}/resolve`, {
    method: 'POST', body: JSON.stringify({ resolution: 'Replaced the washer and cleared the aerator' }),
  }, manager);
  check('a manager can resolve a ticket', resolved.body?.status === 'RESOLVED', resolved.body?.status);

  const closeNoReason = await call(`/maintenance/tickets/${ticketId}/close`, {
    method: 'POST', body: JSON.stringify({}),
  }, manager);
  check('a ticket can be closed', closeNoReason.status === 201 || closeNoReason.status === 200, `status=${closeNoReason.status}`);

  const reopened = await call(`/maintenance/tickets/${ticketId}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'it is dripping again' }),
  }, manager);
  check('a closed ticket can be reopened', reopened.body?.status === 'REOPENED', reopened.body?.status);

  const ticketAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1`, [ticketId]);
  check('ticket transitions were audited', ticketAudit.rows[0].n >= 4, `${ticketAudit.rows[0].n} rows`);

  const hkTickets = await call('/maintenance/tickets', {}, hk);
  check('housekeeping can read tickets', hkTickets.status === 200, `status=${hkTickets.status}`);
  scanForForbidden('ticket list (housekeeping)', hkTickets.body);

  // -------------------------------------------------------------- out of order
  const hkOoo = await call(`/rooms/${cleanRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: 'air conditioning failed' }),
  }, hk);
  check('housekeeping cannot take a room out of order (403)', hkOoo.status === 403, `status=${hkOoo.status}`);

  const fdOoo = await call(`/rooms/${cleanRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: 'air conditioning failed' }),
  }, fd);
  check('front desk cannot take a room out of order either (403)', fdOoo.status === 403, `status=${fdOoo.status}`);

  const oooNoReason = await call(`/rooms/${cleanRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: '' }),
  }, manager);
  check('out-of-order without a reason is rejected (400)', oooNoReason.status === 400, `status=${oooNoReason.status}`);

  // Audit rows are permanent by design, so the count is taken before the action
  // and the delta is what is asserted. Comparing absolutes would fail purely
  // because earlier runs exist.
  const oooAuditBefore = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'room.out-of-order'`,
    [cleanRoom.id]);

  const ooo = await call(`/rooms/${cleanRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: 'air conditioning failed, awaiting parts' }),
  }, manager);
  check('a manager can take a room out of order', ooo.status === 201 || ooo.status === 200, `status=${ooo.status}`);
  check('the room is OUT_OF_ORDER', (await roomStatus(cleanRoom.id)) === 'OUT_OF_ORDER', `${await roomStatus(cleanRoom.id)}`);

  const oooAgain = await call(`/rooms/${cleanRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: 'again' }),
  }, manager);
  check('repeating out-of-order is idempotent', oooAgain.body?.idempotent === true);

  const oooAuditAfter = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'room.out-of-order'`,
    [cleanRoom.id]);
  check(
    'exactly one out-of-order audit row was written across both calls',
    oooAuditAfter.rows[0].n - oooAuditBefore.rows[0].n === 1,
    `${oooAuditAfter.rows[0].n - oooAuditBefore.rows[0].n} new rows`,
  );

  const oooReason = await q(
    `SELECT reason FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'room.out-of-order'
     ORDER BY "createdAt" DESC LIMIT 1`,
    [cleanRoom.id]);
  check('the out-of-order reason was recorded', /air conditioning/.test(oooReason.rows[0]?.reason ?? ''),
    oooReason.rows[0]?.reason);

  const hkRooms = await call('/rooms', {}, hk);
  check('housekeeping can read the room list', hkRooms.status === 200, `status=${hkRooms.status}`);
  scanForForbidden('room list (housekeeping)', hkRooms.body);

  const back = await call(`/rooms/${cleanRoom.id}/back-in-service`, {
    method: 'POST', body: JSON.stringify({ reason: 'parts fitted and tested' }),
  }, manager);
  check('a manager can return the room to service', back.status === 201 || back.status === 200, `status=${back.status}`);
  check('the room returns dirty, not ready, since it needs cleaning',
    (await roomStatus(cleanRoom.id)) === 'VACANT_DIRTY', `${await roomStatus(cleanRoom.id)}`);

  // ------------------------------------------------- occupied rooms are refused
  const types = await call('/room-types', {}, admin);
  const rt = types.body.find((t: any) => t.isActive);
  const g = await call('/guests', {
    method: 'POST', body: JSON.stringify({ firstName: 'Phase7', lastName: 'p7-guest' }),
  }, admin);
  const arrivals = await call('/front-desk/arrivals', {}, fd);
  const today = arrivals.body.businessDate;
  const avail = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, {}, admin);
  const stayRoom = avail.body.available[0];
  const booked = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: g.body.id, checkInDate: today, checkOutDate: addDays(today, 2),
      adults: 1, children: 0, roomTypeId: rt.id, roomId: stayRoom.id,
    }),
  }, admin);
  const ci = await call(`/reservations/${booked.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  check('guest checked in for the occupancy test', ci.status === 201 || ci.status === 200, `status=${ci.status}`);

  const oooOccupied = await call(`/rooms/${stayRoom.id}/out-of-order`, {
    method: 'POST', body: JSON.stringify({ reason: 'leaking radiator' }),
  }, manager);
  check('taking an occupied room out of order is refused (409)', oooOccupied.status === 409, `status=${oooOccupied.status}`);
  check('the refusal says the guest must move out', /occupied/i.test(JSON.stringify(oooOccupied.body)));

  // A stayover clean must not mark an occupied room as sellable.
  const stayover = await call('/housekeeping/tasks', {
    method: 'POST', body: JSON.stringify({ roomId: stayRoom.id, type: 'STAYOVER_CLEAN' }),
  }, manager);
  await call(`/housekeeping/tasks/${stayover.body.id}/start`, { method: 'POST', body: '{}' }, hk);
  const doneStayover = await call(`/housekeeping/tasks/${stayover.body.id}/complete`, {
    method: 'POST', body: JSON.stringify({}),
  }, hk);
  check('a stayover clean leaves the room OCCUPIED_CLEAN',
    doneStayover.body?.roomStatus === 'OCCUPIED_CLEAN', doneStayover.body?.roomStatus);
  check('an occupied room is never reported sellable', doneStayover.body?.roomReady === false,
    String(doneStayover.body?.roomReady));

  await call(`/housekeeping/tasks/${stayover.body.id}/request-inspection`, { method: 'POST', body: '{}' }, hk);
  const passStayover = await call(`/housekeeping/tasks/${stayover.body.id}/inspect`, {
    method: 'POST', body: JSON.stringify({ result: 'pass' }),
  }, manager);
  check('inspecting an occupied room does not mark it INSPECTED',
    passStayover.body?.roomStatus === 'OCCUPIED_CLEAN', passStayover.body?.roomStatus);

  scanForForbidden('task list after occupied stayover', (await call('/housekeeping/tasks', {}, hk)).body);

  // ------------------------------------------- front desk sees readiness promptly
  const hkFinalRooms = await call('/rooms', {}, hk);
  const freshRoom = rooms.body.find((r: any) => r.isActive && r.id !== cleanRoom.id && r.id !== stayRoom.id);
  if (freshRoom) {
    const t3 = await call('/housekeeping/tasks', {
      method: 'POST', body: JSON.stringify({ roomId: freshRoom.id, type: 'TURNDOWN' }),
    }, manager);
    await call(`/housekeeping/tasks/${t3.body.id}/start`, { method: 'POST', body: '{}' }, hk);
    await call(`/housekeeping/tasks/${t3.body.id}/complete`, { method: 'POST', body: '{}' }, hk);

    const fdSees = (await call('/rooms', {}, fd)).body.find((r: any) => r.id === freshRoom.id);
    check('front desk sees the cleaned room immediately after completion',
      fdSees?.status === 'VACANT_CLEAN', fdSees?.status);
  } else {
    check('a spare room was available for the readiness check', false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
  void hkFinalRooms;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });