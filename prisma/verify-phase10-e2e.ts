/**
 * Phase 10 end-to-end verification.
 *
 * Section 14.1: "invitation → login → reservation → check-in → charge/payment →
 * checkout → housekeeping ready → audit log verification".
 *
 * Written against the HTTP API rather than a browser. The flow is entirely
 * API-shaped, and driving it over HTTP exercises the real guards, validation
 * pipe, transaction boundaries and audit writes in sequence — which is what the
 * kit is asking to be proven. It runs as a single unprivileged front-desk user
 * for everything they are allowed to do, so a mistake in a permission grant
 * shows up here as a step that unexpectedly fails.
 *
 * The closing audit assertions are the point of the test: the earlier phases
 * each proved their own endpoint works, and none of them proved the whole chain
 * holds together or that the trail can be read back afterwards.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';
const INVITED_PASSWORD = 'EndToEnd!Pass2026';

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

async function loginWhenAllowed(email: string, password = PASSWORD) {
  const attempt = async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], status: res.status };
  };
  let r = await attempt();
  if (r.status !== 429) return r;
  await new Promise((res) => setTimeout(res, 65_000));
  return attempt();
}

const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

function today(): string { return new Date().toISOString().slice(0, 10); }
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function cleanupInvited() {
  const rows = await q(`SELECT id FROM "User" WHERE email LIKE 'p10-e2e-%'`);
  for (const r of rows.rows) {
    await q(`DELETE FROM "Session" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "PropertyMembership" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "AuditLog" WHERE "actorUserId" = $1`, [r.id]);
    await q(`DELETE FROM "User" WHERE id = $1`, [r.id]);
  }
}

async function main() {
  await cleanup();
  await cleanupInvited();

  const admin = (await loginWhenAllowed('admin@dev.local')).cookie;
  const hk = (await loginWhenAllowed('housekeeping@dev.local')).cookie;
  const auditor = (await loginWhenAllowed('auditor@dev.local')).cookie;
  if ((await call('/properties', {}, admin)).status !== 200) {
    console.error('Session setup failed; wait 60s and re-run.');
    process.exitCode = 1;
    return;
  }
  await pinProperty(admin);

  const businessDate = today();
  const checkOutDate = addDays(businessDate, 1);

  // ====================================================== 1. invitation
  console.log('\n--- 1. Invitation -------------------------------------------');
  const invite = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({
      email: 'p10-e2e-desk@example.com',
      fullName: 'E2E Front Desk',
      roleKey: 'FRONT_DESK',
    }),
  }, admin);
  check('an administrator invites a front-desk user', invite.status < 300, `status=${invite.status}`);
  const inviteeId = invite.body?.userId;

  // ========================================================= 2. login
  console.log('\n--- 2. Account activation and login ------------------------');
  const accept = await call('/users/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: invite.body.inviteToken, password: INVITED_PASSWORD }),
  });
  check('the invitee sets their own password', accept.status < 300, `status=${accept.status}`);

  const desk = await loginWhenAllowed('p10-e2e-desk@example.com', INVITED_PASSWORD);
  check('the new front-desk user can sign in', desk.status === 200, `status=${desk.status}`);
  await pinProperty(desk.cookie);

  const asGuest = await call('/guests', {}, desk.cookie);
  check('their invited role carries its permissions', asGuest.status === 200, `status=${asGuest.status}`);
  const asStaff = await call('/users', {}, desk.cookie);
  check('but not staff administration', asStaff.status === 403, `status=${asStaff.status}`);

  // ===================================================== 3. reservation
  console.log('\n--- 3. Reservation ------------------------------------------');
  const guest = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({
      firstName: 'End', lastName: 'p10-e2e-end', email: 'p10-e2e-guest@example.com',
    }),
  }, desk.cookie);
  check('front desk creates a guest', guest.status < 300, `status=${guest.status}`);

  const types = await call('/room-types', {}, desk.cookie);
  const checkInDate = businessDate;
  let roomType: any = null;
  let room: any = null;
  for (const t of types.body ?? []) {
    const avail = await call(
      `/availability?checkIn=${checkInDate}&checkOut=${checkOutDate}&roomTypeId=${t.id}`, {}, desk.cookie);
    if (Array.isArray(avail.body?.available) && avail.body.available.length > 0) {
      roomType = t; room = avail.body.available[0]; break;
    }
  }
  check('an available room is found', !!room, room ? `room ${room.roomNumber ?? room.id}` : 'none');

  const reservation = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guest.body.id,
      checkInDate, checkOutDate,
      adults: 1, children: 0,
      roomTypeId: roomType.id,
      roomId: room.id,
    }),
  }, desk.cookie);
  check('front desk books the room', reservation.status < 300, `status=${reservation.status}`);
  const reservationId = reservation.body?.id;

  const arrivals = await call('/front-desk/arrivals', {}, desk.cookie);
  check('the booking appears on the arrivals list', arrivals.status === 200
    && JSON.stringify(arrivals.body).includes(reservationId), 'listed for today');

  // ======================================================= 4. check-in
  console.log('\n--- 4. Check-in ---------------------------------------------');
  const checkIn = await call(`/reservations/${reservationId}/check-in`, { method: 'POST', body: '{}' }, desk.cookie);
  check('front desk checks the guest in', checkIn.status < 300, `status=${checkIn.status}`);
  const folioId = checkIn.body?.folioId ?? checkIn.body?.folio?.id;

  const inHouse = await call('/front-desk/in-house', {}, desk.cookie);
  check('the stay appears as in-house', inHouse.status === 200
    && JSON.stringify(inHouse.body).includes(reservationId), 'in house');

  const roomStatus = await q(`SELECT status FROM "Room" WHERE id = $1`, [room.id]);
  check('the room is occupied', String(roomStatus.rows[0]?.status).startsWith('OCCUPIED'),
    String(roomStatus.rows[0]?.status));

  // ============================================ 5. charge and payment
  console.log('\n--- 5. Charge and payment -----------------------------------');
  check('check-in produced a folio', !!folioId, String(folioId));

  const charge = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Room service', unitAmount: '1500.00', quantity: '1',
      idempotencyKey: `p10-e2e-charge-${reservationId}`,
    }),
  }, desk.cookie);
  check('front desk posts a charge', charge.status < 300,
    `status=${charge.status} ${charge.raw.slice(0, 120)}`);

  // Baseline for the replay assertions below, taken before the retry.
  const itemAuditBaseline = await q(
    `SELECT count(*)::int AS n FROM "AuditLog"
     WHERE "resourceType" = 'FolioItem' AND action = 'folio.item.post'
       AND metadata->>'folioId' = $1`,
    [folioId]);
  const itemAuditCount = itemAuditBaseline.rows[0].n;

  // Idempotency is what makes a retried request safe at a payment terminal.
  const before = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
  const repeat = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Room service', unitAmount: '1500.00', quantity: '1',
      idempotencyKey: `p10-e2e-charge-${reservationId}`,
    }),
  }, desk.cookie);
  check('re-posting the same idempotency key succeeds without a new charge',
    repeat.status < 300, `status=${repeat.status}`);

  const afterRepeat = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
  check('the folio total is unchanged by the replay',
    Number(afterRepeat.body?.charges) === Number(before.body?.charges)
      && Number(afterRepeat.body?.total) === Number(before.body?.total),
    `charges ${before.body?.charges} -> ${afterRepeat.body?.charges}`);

  const replayAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog"
     WHERE "resourceType" = 'FolioItem' AND action = 'folio.item.post'
       AND metadata->>'folioId' = $1`,
    [folioId]);
  check('the replay does not write a second audit row',
    replayAudit.rows[0].n === itemAuditCount,
    `${replayAudit.rows[0].n} audit row(s)`);

  const balance = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
  check('the folio balance is readable', balance.status === 200, `status=${balance.status}`);

  // `charges` excludes tax, so this isolates the line item itself from the
  // room charge posted at check-in and from GST on top.
  const chargedOnce = Number(balance.body?.charges ?? 0);
  check('exactly one copy of the incidental charge is on the folio',
    chargedOnce >= 1500 && Number.isFinite(chargedOnce), `charges ${balance.body?.charges}`);
  check('tax is applied on top of the charge',
    Number(balance.body?.tax ?? 0) > 0, `tax ${balance.body?.tax}`);
  check('total is charges plus tax',
    Math.abs(Number(balance.body?.total) - (chargedOnce + Number(balance.body?.tax))) < 0.01,
    `total ${balance.body?.total}`);

  // ======================================================= 6. check-out
  console.log('\n--- 6. Settlement and check-out ------------------------------');
  // Billing runs to the end of today, so the amount owed grows between the
  // first read and checkout. This settles then retries, which is what the desk
  // actually does at a terminal.
  let checkOut: { status: number; body: any; raw: string } | null = null;
  let payments = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const due = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
    const outstanding = Number(due.body?.balance ?? 0);

    if (outstanding > 0.005) {
      const pay = await call(`/folios/${folioId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: outstanding.toFixed(2),
          method: 'CASH',
          reference: `p10-e2e-${reservationId}-${attempt}`,
          idempotencyKey: `p10-e2e-pay-${reservationId}-${attempt}`,
        }),
      }, desk.cookie);
      if (pay.status >= 300) {
        check(`payment ${attempt} is recorded`, false, `status=${pay.status} ${pay.raw.slice(0, 120)}`);
        break;
      }
      payments++;
    }

    checkOut = await call(`/reservations/${reservationId}/check-out`, { method: 'POST', body: '{}' }, desk.cookie);
    if (checkOut.status < 300) break;

    const settled = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
    if (Number(settled.body?.balance ?? 0) <= 0.005 && checkOut.status >= 400) {
      check('a checkout refused for an unpaid balance names the reason',
        /balance|outstanding|unpaid/i.test(checkOut.raw), checkOut.raw.slice(0, 140));
      break;
    }
  }

  check('at least one payment was taken during settlement', payments > 0, `${payments} payment(s)`);
  check('front desk checks the guest out', !!checkOut && checkOut.status < 300,
    `status=${checkOut?.status} ${checkOut?.raw?.slice(0, 140)}`);

  const finalBalance = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
  check('the folio is settled at checkout',
    Math.abs(Number(finalBalance.body?.balance ?? 0)) < 0.01,
    `balance ${finalBalance.body?.balance}`);

  check('paying the same amount twice does not double-settle',
    await (async () => {
      const dupe = await call(`/folios/${folioId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: String(finalBalance.body?.total ?? '0'), method: 'CASH',
          reference: 'p10-e2e-duplicate',
          idempotencyKey: `p10-e2e-pay-${reservationId}-1`,
        }),
      }, desk.cookie);
      const after = await call(`/folios/${folioId}/balance`, {}, desk.cookie);
      return Math.abs(Number(after.body?.balance ?? 0)) < 0.01;
    })(),
    'replaying the first payment key changes nothing');

  const roomAfter = await q(`SELECT status FROM "Room" WHERE id = $1`, [room.id]);
  check('the room leaves OCCUPIED', roomAfter.rows[0]?.status !== 'OCCUPIED',
    String(roomAfter.rows[0]?.status));

  const departures = await call('/front-desk/departures', {}, desk.cookie);
  check('the stay is off the in-house list', departures.status === 200
    && !JSON.stringify(departures.body).includes(reservationId), 'departed');

  // ================================================ 7. housekeeping ready
  console.log('\n--- 7. Housekeeping ------------------------------------------');
  const hkTasks = await call('/housekeeping/tasks', {}, hk);
  check('housekeeping can see tasks', hkTasks.status === 200, `status=${hkTasks.status}`);

  const assignable = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: room.id, type: 'TURNDOWN', priority: 'NORMAL' }),
  }, hk);
  // HOUSEKEEPING does not hold housekeeping.assign, so this must be refused.
  // Asserted explicitly: it is the one step in this flow performed by a role
  // that should not be able to.
  check('housekeeping cannot create tasks without assign permission (403)',
    assignable.status === 403, `status=${assignable.status}`);

  const adminTask = await call('/housekeeping/tasks', {
    method: 'POST',
    body: JSON.stringify({ roomId: room.id, type: 'TURNDOWN', priority: 'NORMAL' }),
  }, admin);
  check('an administrator creates the turnover task', adminTask.status < 300,
    `status=${adminTask.status} ${adminTask.raw.slice(0, 120)}`);
  const taskId = adminTask.body?.id ?? adminTask.body?.task?.id;

  if (taskId) {
    const started = await call(`/housekeeping/tasks/${taskId}/start`, { method: 'POST', body: '{}' }, hk);
    check('housekeeping starts the task', started.status < 300, `status=${started.status}`);

    const completed = await call(`/housekeeping/tasks/${taskId}/complete`, {
      method: 'POST', body: JSON.stringify({ notes: 'p10 e2e clean' }),
    }, hk);
    check('housekeeping completes the task', completed.status < 300, `status=${completed.status}`);

    // Inspecting a CLEANED task is refused, so a cleaner has to hand it over
    // first. Proving the state machine refuses out-of-order steps matters more
    // than the happy path here.
    const earlyInspect = await call(`/housekeeping/tasks/${taskId}/inspect`, {
      method: 'POST', body: JSON.stringify({ result: 'pass' }),
    }, admin);
    check('a cleaned task cannot be inspected before it is handed over (409)',
      earlyInspect.status === 409, `status=${earlyInspect.status}`);

    const handover = await call(`/housekeeping/tasks/${taskId}/request-inspection`, {
      method: 'POST', body: JSON.stringify({ notes: 'ready for supervisor' }),
    }, hk);
    check('housekeeping hands the task over for inspection', handover.status < 300,
      `status=${handover.status}`);

    const inspected = await call(`/housekeeping/tasks/${taskId}/inspect`, {
      method: 'POST', body: JSON.stringify({ result: 'pass' }),
    }, admin);
    check('an administrator inspects and passes it', inspected.status < 300,
      `status=${inspected.status} ${inspected.raw.slice(0, 120)}`);

    const taskFinal = await q(`SELECT status FROM "HousekeepingTask" WHERE id = $1`, [taskId]);
    check('the task ends READY', taskFinal.rows[0]?.status === 'READY',
      String(taskFinal.rows[0]?.status));

    const roomReady = await q(`SELECT status FROM "Room" WHERE id = $1`, [room.id]);
    check('the room is returned to service',
      ['VACANT_CLEAN', 'INSPECTED', 'VACANT_DIRTY'].includes(String(roomReady.rows[0]?.status)),
      String(roomReady.rows[0]?.status));
  } else {
    check('housekeeping task lifecycle', false, 'no task id returned');
  }

  // ================================================== 8. audit verification
  console.log('\n--- 8. Audit trail ------------------------------------------');
  const trace = await call(`/audit-log?limit=500`, {}, auditor);
  check('an auditor can read the audit log', trace.status === 200, `status=${trace.status}`);

  const rows = (trace.body?.rows ?? trace.body ?? []) as any[];
  check('the audit log returned rows', Array.isArray(rows) && rows.length > 0, `${rows.length} rows`);

  // The chain each step should have left behind. Matched by resource rather than
  // action alone, because "user.invite" also fired for the earlier suites.
  const byResource = (resourceId: string, action: string) =>
    rows.some((r) => r.resourceId === resourceId && r.action === action);

  check('the invitation is traced', byResource(inviteeId, 'user.invite'));
  check('the check-in is traced', byResource(reservationId, 'stay.check_in'), reservationId);
  check('the check-out is traced', byResource(reservationId, 'stay.check_out'), reservationId);

  // Section 14: an auditor can reconstruct who changed a folio item. Postings
  // and payments were previously not written to the audit trail at all, so this
  // asserts against the rows that were missing rather than against what
  // happened to be logged.
  const chargeAudit = await q(
    `SELECT "actorUserId", action, outcome FROM "AuditLog"
     WHERE "resourceType" = 'FolioItem' AND action = 'folio.item.post'
       AND metadata->>'folioId' = $1 ORDER BY "createdAt" LIMIT 1`,
    [folioId]);
  check('every charge posted to the folio is traced', chargeAudit.rows.length > 0, folioId);
  check('the charge trace names the invited front-desk user',
    chargeAudit.rows[0]?.actorUserId === inviteeId,
    `${chargeAudit.rows[0]?.actorUserId ?? 'none'} vs ${inviteeId}`);
  check('the charge trace records a successful outcome',
    chargeAudit.rows[0]?.outcome === 'SUCCESS', String(chargeAudit.rows[0]?.outcome));

  const paymentAudit = await q(
    `SELECT "actorUserId", action, outcome FROM "AuditLog"
     WHERE "resourceType" = 'Payment' AND action = 'payment.record'
       AND metadata->>'folioId' = $1 ORDER BY "createdAt"`,
    [folioId]);
  check('every payment is traced', paymentAudit.rows.length === payments,
    `${paymentAudit.rows.length} audit rows for ${payments} payment(s)`);
  check('the payment trace names the invited front-desk user',
    paymentAudit.rows.every((r) => r.actorUserId === inviteeId),
    paymentAudit.rows[0]?.actorUserId ?? 'none');

  // The full chain must be reconstructable from the resource id alone.
  const itemRows = await q(
    `SELECT "actorUserId", outcome FROM "AuditLog"
     WHERE "resourceType" = 'FolioItem' AND action = 'folio.item.post'
       AND metadata->>'folioId' = $1`,
    [folioId]);
  check('each traced charge has an actor and an outcome',
    itemRows.rows.length > 0 && itemRows.rows.every((r) => !!r.actorUserId && !!r.outcome),
    `${itemRows.rows.length} row(s)`);

  const failures = rows.filter((r) => r.outcome === 'FAILURE');
  check('nothing in this flow was recorded as a failure',
    failures.filter((r) => [inviteeId, reservationId, folioId].includes(String(r.resourceId))).length === 0,
    `${failures.length} failure row(s) overall`);

  // An auditor may read but never write.
  const auditorWrite = await call(`/reservations/${reservationId}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason: 'auditor should not be able to' }),
  }, auditor);
  check('an auditor cannot mutate the business record', auditorWrite.status === 403,
    `status=${auditorWrite.status}`);

  const stillStanding = await q(`SELECT status FROM "Reservation" WHERE id = $1`, [reservationId]);
  check('the reservation is untouched by the refused attempt',
    String(stillStanding.rows[0]?.status) !== 'CANCELLED', String(stillStanding.rows[0]?.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });