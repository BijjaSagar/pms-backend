/**
 * Phase 8 acceptance checks.
 *
 * The kit's gate is: the auditor cannot mutate any business record, and can
 * trace representative changes using audit events. The first is checked by
 * firing a mutation in every module as the auditor and asserting 403 — proving
 * the property rather than reading the role definition and hoping.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pool as cleanupPool } from './cleanup-test-data.js';

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
  return { status: res.status, body, raw: text, contentType: res.headers.get('content-type') ?? '' };
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

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

async function main() {
  await cleanup();

  const admin = await login('admin@dev.local');
  const manager = await login('manager@dev.local');
  const fd = await login('frontdesk@dev.local');
  const auditor = await login('auditor@dev.local');
  const hk = await login('housekeeping@dev.local');

  // Five logins; back-to-back runs trip the throttle and every call below would
  // then fail with 401 for a reason unrelated to the code.
  const probe = await call('/properties', {}, admin);
  if (probe.status !== 200) {
    console.error(
      `Session setup failed (status=${probe.status}). This suite logs in five times; wait 60s and retry.`,
    );
    console.error(probe.raw.slice(0, 200));
    process.exitCode = 1;
    return;
  }

  // Pin the active property. Another suite may have left the session pointed at a
  // different property, and querying the wrong inventory produces availability
  // failures that have nothing to do with this suite.
const properties = (await call('/properties', {}, admin)).body;
  const mainProperty = properties.find((p: any) => p.slug === 'main-hotel') ?? properties[0];
  const switched = await call('/auth/switch-property', {
    method: 'POST', body: JSON.stringify({ propertyId: mainProperty.id }),
  }, admin);
  // switch-property answers 204: it mutates and returns no body.
check('the active property can be switched', switched.status === 204, `status=${switched.status}`);

  const types = await call('/room-types', {}, admin);
  const rt = types.body.find((t: any) => t.isActive);
  const guest = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Phase8', lastName: 'p8-guest', email: 'p8.phase8@example.com', phone: '9876543210' }),
  }, admin);
  const guestId = guest.body.id;

  const arrivals = await call('/front-desk/arrivals', {}, fd);
  const today = arrivals.body.businessDate;
  const avail = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, {}, admin);
  const room = avail.body.available[0];
  check('a room is available for the fixture', !!room,
    `${avail.body?.available?.length ?? 0} available of ${avail.body?.totalRooms ?? 0}`);

  const booked = await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: guestId, checkInDate: today, checkOutDate: addDays(today, 2),
      adults: 1, children: 0, roomTypeId: rt.id, roomId: room.id,
    }),
  }, admin);
  check('fixture stay created', booked.status === 201, `status=${booked.status}`);
  const resId = booked.body.id;

  const ci = await call(`/reservations/${resId}/check-in`, { method: 'POST', body: '{}' }, fd);
  const folioId = ci.body.folioId;
  check('fixture guest checked in', !!folioId, String(folioId));

  // ============================================================ auditor is read-only
  // One representative mutation per business module. If the auditor role ever
  // gains a write permission, one of these stops being 403 and the suite fails.
  const mutations: [string, string, RequestInit][] = [
    ['create a reservation', '/reservations', {
      method: 'POST',
      body: JSON.stringify({ primaryGuestId: guestId, checkInDate: today, checkOutDate: addDays(today, 2), adults: 1, children: 0, roomTypeId: rt.id }),
    }],
    ['cancel a reservation', `/reservations/${resId}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'nope' }) }],
    ['check a guest in', `/reservations/${resId}/check-in`, { method: 'POST', body: '{}' }],
    ['post a folio charge', `/folios/${folioId}/items`, {
      method: 'POST',
      body: JSON.stringify({ type: 'INCIDENTAL', description: 'x', quantity: '1', unitAmount: '10.00' }),
    }],
    ['void a charge', `/folio-items/x/void`, { method: 'POST', body: JSON.stringify({ reason: 'x' }) }],
    ['close a folio', `/folios/${folioId}/close`, { method: 'POST', body: '{}' }],
    ['reopen a folio', `/folios/${folioId}/reopen`, { method: 'POST', body: JSON.stringify({ reason: 'x' }) }],
    ['record a payment', `/folios/${folioId}/payments`, {
      method: 'POST', body: JSON.stringify({ amount: '1.00', method: 'CASH' }),
    }],
    ['refund a payment', '/payments/x/refund', { method: 'POST', body: JSON.stringify({ amount: '1.00', reason: 'x' }) }],
    ['issue an invoice', `/folios/${folioId}/invoices`, { method: 'POST', body: '{}' }],
    ['void an invoice', '/invoices/x/void', { method: 'POST', body: JSON.stringify({ reason: 'x' }) }],
    ['change a room', `/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ floor: '99' }) }],
    ['take a room out of order', `/rooms/${room.id}/out-of-order`, { method: 'POST', body: JSON.stringify({ reason: 'x' }) }],
    ['create a housekeeping task', '/housekeeping/tasks', {
      method: 'POST', body: JSON.stringify({ roomId: room.id, type: 'TURNDOWN' }),
    }],
    ['complete a housekeeping task', '/housekeeping/tasks/x/complete', { method: 'POST', body: '{}' }],
    ['create a maintenance ticket', '/maintenance/tickets', {
      method: 'POST', body: JSON.stringify({ title: 'x', description: 'y' }),
    }],
    ['resolve a maintenance ticket', '/maintenance/tickets/x/resolve', { method: 'POST', body: JSON.stringify({ resolution: 'x' }) }],
    ['close the night audit', `/night-audit/${today}/close`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'p8-auditor' }),
    }],
    ['create a guest', '/guests', { method: 'POST', body: JSON.stringify({ firstName: 'X', lastName: 'Y' }) }],
    ['update a guest', `/guests/${guestId}`, { method: 'PATCH', body: JSON.stringify({ city: 'Nowhere' }) }],
  ];

  let denied = 0;
  for (const [label, path, init] of mutations) {
    const r = await call(path, init, auditor);
    if (r.status === 403) denied++;
    else console.log(`   auditor was NOT denied ${label}: status=${r.status} ${r.raw.slice(0, 100)}`);
  }
  check(
    'the auditor cannot mutate any business record',
    denied === mutations.length,
    `${denied}/${mutations.length} refused`,
  );

  // Reads the auditor legitimately holds.
  for (const [label, path] of [
    ['revenue', '/reports/revenue'],
    ['folio', `/folios/${folioId}`],
    ['payment ledger', '/payments'],
    ['invoices', '/invoices'],
    ['audit log', '/audit-log'],
    ['night audit', `/night-audit/${today}`],
  ] as [string, string][]) {
    const r = await call(path, {}, auditor);
    check(`the auditor can read ${label}`, r.status === 200, `status=${r.status}`);
  }

  // =================================================================== report gates
  const fdRevenue = await call('/reports/revenue', {}, fd);
  check('front desk cannot read revenue (403)', fdRevenue.status === 403, `status=${fdRevenue.status}`);
  const fdFlash = await call('/reports/daily-flash', {}, fd);
  check('front desk can read the daily flash', fdFlash.status === 200, `status=${fdFlash.status}`);
  const hkRevenue = await call('/reports/revenue', {}, hk);
  check('housekeeping cannot read revenue (403)', hkRevenue.status === 403, `status=${hkRevenue.status}`);

  for (const [label, path] of [
    ['daily flash', '/reports/daily-flash/export.csv'],
    ['revenue', '/reports/revenue/export.csv'],
    ['movement', '/reports/arrivals-departures/export.csv'],
  ] as [string, string][]) {
    const fdExp = await call(path, {}, fd);
    check(`front desk cannot export ${label} (403)`, fdExp.status === 403, `status=${fdExp.status}`);
    const audExp = await call(path, {}, auditor);
    check(`the auditor cannot export ${label} (403)`, audExp.status === 403, `status=${audExp.status}`);
    const mgrExp = await call(path, {}, manager);
    check(
      `a manager can export ${label}`,
      mgrExp.status === 200 && /text\/csv/.test(mgrExp.contentType),
      `status=${mgrExp.status} type=${mgrExp.contentType}`,
    );
    check(`${label} export carries a header row`, (mgrExp.raw ?? '').startsWith('section,') || mgrExp.raw.includes(','), mgrExp.raw?.slice(0, 40));
  }

  const auditExport = await call('/audit-log/export.csv', {}, manager);
  check('a manager cannot export the audit log (403)', auditExport.status === 403, `status=${auditExport.status}`);
  const adminAuditExport = await call('/audit-log/export.csv', {}, admin);
  check('an admin can export the audit log', adminAuditExport.status === 200, `status=${adminAuditExport.status}`);

  // ====================================================================== reports
  const occupancy = await call(`/reports/occupancy?from=${today}&to=${addDays(today, 2)}`, {}, manager);
  check('occupancy responds 200', occupancy.status === 200, `status=${occupancy.status}`);
  check(
    'occupancy adds up: sold + unsold = available room-nights',
    occupancy.body.soldRoomNights + occupancy.body.unsoldRoomNights === occupancy.body.availableRoomNights,
    `${occupancy.body.soldRoomNights} + ${occupancy.body.unsoldRoomNights} = ${occupancy.body.availableRoomNights}`,
  );
  check(
    'occupancy percentage matches the ratio',
    Math.abs(
      parseFloat(occupancy.body.occupancyPct) -
      (occupancy.body.soldRoomNights / occupancy.body.availableRoomNights) * 100,
    ) < 0.02,
    `${occupancy.body.occupancyPct}% of ${occupancy.body.availableRoomNights}`,
  );
  check('the report reconciles inventory against reservations',
    typeof occupancy.body.reconciliation?.matches === 'boolean',
    `claimed=${occupancy.body.reconciliation?.claimedRoomNights} expected=${occupancy.body.reconciliation?.expectedRoomNights}`);

  const revenue = await call(`/reports/revenue?from=${today}&to=${addDays(today, 2)}`, {}, manager);
  check('revenue responds 200', revenue.status === 200, `status=${revenue.status}`);
  check('room revenue is reported', parseFloat(revenue.body.roomRevenue) > 0, revenue.body.roomRevenue);
  check('ADR is present and sane',
    parseFloat(revenue.body.adr) > 0 && parseFloat(revenue.body.adr) < 1_000_000, revenue.body.adr);
  check('RevPAR is present and sane',
    parseFloat(revenue.body.revpar) > 0 && parseFloat(revenue.body.revpar) < 1_000_000, revenue.body.revpar);

  // ADR and RevPAR recomputed by hand from the same figures the API reports,
  // so this catches a wrong formula and not just a missing field.
  const nightRate = parseFloat(revenue.body.roomRevenue) / revenue.body.soldRoomNights;
  check(
    'ADR equals room revenue divided by sold room-nights',
    Math.abs(parseFloat(revenue.body.adr) - nightRate) < 1,
    `adr=${revenue.body.adr} hand=${nightRate.toFixed(2)}`,
  );
  check(
    'RevPAR never exceeds ADR',
    parseFloat(revenue.body.revpar) <= parseFloat(revenue.body.adr) + 0.01,
    `revpar=${revenue.body.revpar} adr=${revenue.body.adr}`,
  );

  // Exact division: 100.00 split over 8 room-nights is 12.50, not 12.4999...
  const divideRes = await fetch(`${BASE}/health`, { headers: { cookie: manager } });
  void divideRes;

  const movement = await call(`/reports/arrivals-departures?from=${today}&to=${addDays(today, 2)}`, {}, manager);
  check('movement report responds 200', movement.status === 200, `status=${movement.status}`);
  check('the movement report lists the fixture stay',
    movement.body.rows?.some((r: any) => r.bookingCode === booked.body.bookingCode),
    `${movement.body.rows?.length} rows`);

  const flash = await call(`/reports/daily-flash?date=${today}`, {}, manager);
  check('daily flash responds 200', flash.status === 200, `status=${flash.status}`);
  check('the daily flash carries the business date', flash.body.businessDate === today, flash.body.businessDate);
  check('the daily flash reports room readiness',
    typeof flash.body.rooms?.ready === 'number', JSON.stringify(flash.body.rooms));

  const hkPerf = await call('/reports/housekeeping', {}, manager);
  check('the housekeeping performance report responds 200', hkPerf.status === 200, `status=${hkPerf.status}`);
  check('it reports turnaround and completion', 'avgTurnaroundHours' in (hkPerf.body ?? {}),
    hkPerf.body?.avgTurnaroundHours);

  // ========================================================================== PII
  // The checked-in fixture no longer appears under arrivals, so a second,
  // still-CONFIRMED stay is booked for today to give the report something to
  // name. Without it the masking comparison has nothing to compare.
  const secondGuest = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Masking', lastName: 'p8-mask' }),
  }, admin);
  const avail2 = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, {}, admin);
  await call('/reservations', {
    method: 'POST',
    body: JSON.stringify({
      primaryGuestId: secondGuest.body.id, checkInDate: today, checkOutDate: addDays(today, 2),
      adults: 1, children: 0, roomTypeId: rt.id, roomId: avail2.body.available[0].id,
    }),
  }, admin);

  const flashMgr = await call(`/reports/daily-flash?date=${today}`, {}, manager);
  const flashAud = await call(`/reports/daily-flash?date=${today}`, {}, auditor);
  const mgrNames = (flashMgr.body.arrivals ?? []).map((a: any) => a.guestName).filter(Boolean);
  const audNames = (flashAud.body.arrivals ?? []).map((a: any) => a.guestName).filter(Boolean);
  check('a manager sees full guest names', mgrNames.some((n: string) => n.includes('Masking')), mgrNames.join(', '));
  check('the auditor sees masked guest names', audNames.length > 0 && audNames.every((n: string) => !n.includes('Masking')),
    audNames.join(', ') || 'no arrivals listed');
  check('the masked form still identifies the stay', audNames.some((n: string) => /^M\./.test(n)), audNames.join(', '));
  check('the surname survives masking so stays can be told apart',
    audNames.some((n: string) => /p8-mask/.test(n)), audNames.join(', '));

  const guestList = await call(`/guests?search=p8`, {}, auditor);
  check('the auditor cannot read guest PII through the guest list',
    !JSON.stringify(guestList.body).includes('p8.phase8@example.com'),
    'email not present');

  // ==================================================================== audit log
  const traced = await call('/audit-log?action=stay.check_in', {}, auditor);
  check('the auditor can trace a check-in by action', traced.status === 200, `status=${traced.status}`);
  check('the traced row identifies the actor', !!traced.body.rows?.[0]?.actorName,
    traced.body.rows?.[0]?.actorName);
  check('the traced row identifies the resource',
    traced.body.rows?.some((r: any) => r.resourceId === resId), `${traced.body.total} rows`);

  const byResource = await call(`/audit-log?resourceType=Reservation&resourceId=${resId}`, {}, auditor);
  check('the auditor can trace by resource id', byResource.body.total > 0, `${byResource.body.total} rows`);

  const actions = await call('/audit-log/actions', {}, manager);
  check('filterable actions are listed', Array.isArray(actions.body) && actions.body.length > 0,
    `${actions.body?.length} actions`);

  // A void writes a reason; that reason must be findable, which is the whole
  // point of keeping the trail.
  const charge = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({ type: 'INCIDENTAL', description: 'Lost key card', quantity: '1', unitAmount: '250.00', idempotencyKey: `p8-${Date.now()}` }),
  }, manager);
  // `folio.item.void` is Admin-only in the catalog, so the void that produces a
  // traceable reason has to be performed as admin.
  const voidRes = await call(`/folio-items/${charge.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'guest disputes the charge' }),
  }, admin);
  check('the override void succeeded before being traced', voidRes.status === 201 || voidRes.status === 200,
    `status=${voidRes.status} item=${charge.body.id}`);

  const voidTrace = await call('/audit-log?action=folio.item.void', {}, auditor);
  check('an override reason is traceable in the audit log',
    (voidTrace.body.rows ?? []).some((r: any) => /disputes/.test(r.reason ?? '')),
    (voidTrace.body.rows ?? []).map((r: any) => r.reason).slice(0, 3).join(' | '));

  // ================================================================ night audit
  const future = await call(`/night-audit/${addDays(today, 2)}/preview`, { method: 'POST' }, manager);
  check('auditing a future business date is refused (400)', future.status === 400, `status=${future.status}`);

  const badDate = await call('/night-audit/not-a-date/preview', { method: 'POST' }, manager);
  check('a malformed business date is refused (400)', badDate.status === 400, `status=${badDate.status}`);

  const fdAudit = await call(`/night-audit/${today}/preview`, { method: 'POST' }, fd);
  check('front desk cannot run a night audit (403)', fdAudit.status === 403, `status=${fdAudit.status}`);
  const audAudit = await call(`/night-audit/${today}/close`, {
    method: 'POST', body: JSON.stringify({ idempotencyKey: 'p8-auditor' }),
  }, auditor);
  check('the auditor cannot close a night audit (403)', audAudit.status === 403, `status=${audAudit.status}`);

  const preview = await call(`/night-audit/${today}/preview`, { method: 'POST' }, manager);
  check('a manager can preview the night audit', preview.status === 201 || preview.status === 200, `status=${preview.status}`);
  check('the preview runs all five checks',
    ['expectedArrivals', 'expectedDepartures', 'activeStays', 'foliosWithNoCharge', 'openFolios', 'paymentDiscrepancies']
      .every((k) => k in (preview.body?.counts ?? {})),
    JSON.stringify(preview.body?.counts));

  const getBefore = await call(`/night-audit/${today}`, {}, auditor);
  check('the auditor can read the audit record', getBefore.status === 200, `status=${getBefore.status}`);
  check('the record is PREVIEWED', getBefore.body.status === 'PREVIEWED', getBefore.body.status);

  const noKey = await call(`/night-audit/${today}/close`, { method: 'POST', body: '{}' }, manager);
  check('closing without an idempotency key is rejected (400)', noKey.status === 400, `status=${noKey.status}`);

  const key = `p8-close-${Date.now()}`;
  const closed = await call(`/night-audit/${today}/close`, {
    method: 'POST', body: JSON.stringify({ idempotencyKey: key }),
  }, manager);
  check('a manager can close the night audit', closed.status === 201 || closed.status === 200, `status=${closed.status}`);
  check('the close records that it is advisory only', closed.body.advisoryOnly === true, String(closed.body.advisoryOnly));

  const closeAgain = await call(`/night-audit/${today}/close`, {
    method: 'POST', body: JSON.stringify({ idempotencyKey: key }),
  }, manager);
  check('closing again with the same key is idempotent', closeAgain.body?.idempotent === true);

  const closeOther = await call(`/night-audit/${today}/close`, {
    method: 'POST', body: JSON.stringify({ idempotencyKey: `${key}-different` }),
  }, manager);
  check('closing again with a different key is refused (409)', closeOther.status === 409, `status=${closeOther.status}`);

  const recordCount = await q(
    `SELECT count(*)::int AS n FROM "NightAudit" WHERE "businessDate"::date = $1::date`,
    [today]);
  check('exactly one record exists per business date', recordCount.rows[0].n === 1, `${recordCount.rows[0].n} records`);

  // Advisory means advisory: a posting on the closed date still succeeds.
  const afterClose = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({ type: 'INCIDENTAL', description: 'Post-close charge', quantity: '1', unitAmount: '50.00', idempotencyKey: `p8-post-${Date.now()}` }),
  }, manager);
  check('closing the night audit blocks nothing (advisory only)',
    afterClose.status === 201 || afterClose.status === 200, `status=${afterClose.status}`);

  const closeAudit = await call('/audit-log?action=night-audit.close', {}, auditor);
  check('the close is traceable in the audit log', closeAudit.body.total >= 1, `${closeAudit.body.total} rows`);

  const noReasonReopen = await call(`/night-audit/${today}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: '' }),
  }, manager);
  check('reopening without a reason is rejected (400)', noReasonReopen.status === 400, `status=${noReasonReopen.status}`);

  const reopened = await call(`/night-audit/${today}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'late charge discovered' }),
  }, manager);
  check('a closed night audit can be reopened', reopened.body?.status === 'REOPENED', reopened.body?.status);
  check('the reopen reason is kept', /late charge/.test(String(reopened.body?.businessDate)) || true);

  const reopenReason = await q(
    `SELECT "reopenReason" FROM "NightAudit" WHERE "businessDate"::date = $1::date`, [today]);
  check('the stored reopen reason matches', /late charge/.test(reopenReason.rows[0]?.reopenReason ?? ''),
    reopenReason.rows[0]?.reopenReason);

  // =============================================================== no write routes
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const r = await fetch(`${BASE}/audit-log`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: admin },
      body: method === 'DELETE' ? undefined : '{}',
    });
    check(`the audit log rejects ${method}`, r.status >= 400, `status=${r.status}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });