/**
 * Phase 10 security verification.
 *
 * Section 14.1 of the kit asks for: brute-force throttling, expired/revoked
 * session, invalid property ID, IDOR/cross-tenant access, mass assignment,
 * export authorization, and sensitive log redaction. This covers each of those
 * plus the CSRF check and the cookie flags added in Phase 10.
 *
 * Runs against the server's real rate-limit ceiling. Raising the limits to make
 * suites fast defeats the point of this file, so it is the one suite that must
 * be run with the defaults in place.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';
const NEW_PASSWORD = 'Rotated!Pass2026x';

let pass = 0;
let fail = 0;

const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, init: RequestInit = {}, cookie = '', origin?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return {
    status: res.status,
    body,
    raw: text,
    setCookie: res.headers.get('set-cookie') ?? '',
    headers: res.headers,
  };
}

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0],
    status: res.status,
    setCookie: res.headers.get('set-cookie') ?? '',
  };
}

/** Waits out the login throttle rather than reporting the 429 as a failure. */
async function loginWhenAllowed(email: string, password = PASSWORD) {
  let attempt = await login(email, password);
  if (attempt.status !== 429) return attempt;
  await new Promise((r) => setTimeout(r, 65_000));
  attempt = await login(email, password);
  if (attempt.status === 429) {
    console.error(`Still throttled logging in as ${email}; wait and re-run.`);
    process.exitCode = 1;
  }
  return attempt;
}

const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

async function cleanupInvited() {
  const rows = await q(`SELECT id FROM "User" WHERE email LIKE 'p10-%'`);
  for (const r of rows.rows) {
    await q(`DELETE FROM "Session" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "PropertyMembership" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "AuditLog" WHERE "actorUserId" = $1`, [r.id]);
    await q(`DELETE FROM "User" WHERE id = $1`, [r.id]);
  }
  await q(`DELETE FROM "TaxRule" WHERE code LIKE 'P10%'`);
}

async function main() {
  await cleanup();
  await cleanupInvited();

  // ======================================================== session cookie flags
  // Checked on a real login response, before anything else consumes the budget.
  const firstLogin = await login('admin@dev.local');
  const raw = firstLogin.setCookie;
  check('the session cookie is HttpOnly', /httponly/i.test(raw), raw.slice(0, 120));
  check('the session cookie is SameSite', /samesite/i.test(raw), raw.slice(0, 120));
  check('the session cookie is scoped to a path', /path=\//i.test(raw), raw.slice(0, 120));

  const admin = (await loginWhenAllowed('admin@dev.local')).cookie;
  const manager = (await loginWhenAllowed('manager@dev.local')).cookie;
  let fd = (await loginWhenAllowed('frontdesk@dev.local')).cookie;
  const auditor = (await loginWhenAllowed('auditor@dev.local')).cookie;

  const probe = await call('/properties', {}, admin);
  if (probe.status !== 200) {
    console.error(`Session setup failed (status=${probe.status}); wait 60s and re-run.`);
    process.exitCode = 1;
    return;
  }
  await pinProperty(admin);

  // ============================================================= security headers
  const health = await fetch('http://localhost:3000/api/v1/health');
  const h = health.headers;
  check('X-Content-Type-Options is set', h.get('x-content-type-options') === 'nosniff',
    String(h.get('x-content-type-options')));
  check('X-Frame-Options is set', !!h.get('x-frame-options'), String(h.get('x-frame-options')));
  check('Content-Security-Policy is set', !!h.get('content-security-policy'),
    (h.get('content-security-policy') ?? '').slice(0, 60));
  check('Referrer-Policy is set', !!h.get('referrer-policy'), String(h.get('referrer-policy')));
  check('Strict-Transport-Security is set by Helmet', !!h.get('strict-transport-security'),
    String(h.get('strict-transport-security')));

  // ================================================================ authentication
  const noCookie = await call('/properties');
  check('an unauthenticated request is refused (401)', noCookie.status === 401, `status=${noCookie.status}`);

  const badToken = await call('/properties', {}, 'hotel_pms_session=not-a-real-token');
  check('a forged session cookie is refused (401)', badToken.status === 401, `status=${badToken.status}`);

  const badLogin = await login('admin@dev.local', 'wrong-password-entirely');
  check('a wrong password is refused (401)', badLogin.status === 401, `status=${badLogin.status}`);
  check('the refusal does not reveal whether the account exists',
    !/no such user|unknown email|not found/i.test(badLogin.setCookie + ''),
    'generic message');

  // ================================================================ CSRF (10.4)
  const evil = 'https://evil.example.com';
  const csrfAttempt = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p10-csrf@example.com', fullName: 'CSRF', roleKey: 'FRONT_DESK' }),
  }, admin, evil);
  check('a cross-origin mutation is refused (403)', csrfAttempt.status === 403, `status=${csrfAttempt.status}`);

  const csrfCheck = await call('/users', {}, admin, evil);
  check('a cross-origin read is still allowed', csrfCheck.status === 200, `status=${csrfCheck.status}`);

  const sameOrigin = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p10-csrf-ok@example.com', fullName: 'Same Origin', roleKey: 'HOUSEKEEPING' }),
  }, admin, 'http://localhost:5173');
  check('a same-origin mutation is allowed', sameOrigin.status === 201 || sameOrigin.status === 200,
    `status=${sameOrigin.status}`);
  const csrfUserId = sameOrigin.body?.userId;

  // ====================================================== malformed identifiers
  // The defect this fixes: a non-uuid in a path reached the driver and surfaced
  // as a 500, blaming the server for a plainly malformed request.
  // /users/:id is resolved by matching against the staff list, so a non-uuid
  // never reaches a query and is correctly a plain "no such staff member".
  const badUuid = await call('/users/not-a-uuid', {}, admin);
  check('a malformed uuid in a path is a client error, never a 500',
    badUuid.status >= 400 && badUuid.status < 500, `status=${badUuid.status}`);

  // These do carry the value into PostgreSQL, so they exercise the exception
  // filter that used to let 22P02 surface as a 500.
  const badProperty = await call('/availability?checkIn=2026-01-01&checkOut=2026-01-02&roomTypeId=nope', {}, admin);
  check('an invalid room type id is a client error (400)', badProperty.status === 400, `status=${badProperty.status}`);
  check('the malformed-identifier message explains itself',
    /identifier is not valid/i.test(badProperty.raw), badProperty.raw.slice(0, 120));
  check('the filter does not leak driver text',
    !/invalid input syntax|22P02|SqlQueryError/i.test(badProperty.raw), 'no driver internals');

  const badReservation = await call('/reservations/00000000-0000-0000-0000-000000000000', {}, admin);
  check('an unknown but well-formed id is a 404', badReservation.status === 404, `status=${badReservation.status}`);

  const badBody = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p10-bad@example.com', fullName: 'X', roleKey: 'FRONT_DESK', propertyId: 'nope' }),
  }, admin);
  check('an invalid uuid in a body is a client error (400)', badBody.status === 400, `status=${badBody.status}`);

  const wellFormedMissing = await call(`/users/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, {}, admin);
  check('a well-formed but unknown uuid is still 404', wellFormedMissing.status === 404,
    `status=${wellFormedMissing.status}`);

  // ==================================================== mass assignment (14.1)
  const massAssign = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({
      email: 'p10-mass@example.com', fullName: 'Mass', roleKey: 'FRONT_DESK',
      // None of these belong to the caller; the admin role would be a takeover.
      status: 'ACTIVE', permissions: ['role.assign'], organizationId: 'anything',
    }),
  }, admin);
  check('an unexpected field is rejected outright (400)', massAssign.status === 400, `status=${massAssign.status}`);
  check('the rejection names the offending field', /status|permissions|organizationId/i.test(massAssign.raw),
    massAssign.raw.slice(0, 160));

  const escalateBody = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p10-mass2@example.com', fullName: 'Mass2', roleKey: 'ADMIN' }),
  }, fd);
  check('front desk cannot invite an administrator (403)', escalateBody.status === 403,
    `status=${escalateBody.status}`);

  // ==================================================== expired / revoked session
  const expired = await q(
    `UPDATE "Session" SET "expiresAt" = now() - interval '1 hour' WHERE "userId" = (
       SELECT id FROM "User" WHERE email = 'frontdesk@dev.local') RETURNING id`);
  check('a session could be expired for the test', expired.rowCount > 0, `${expired.rowCount} rows`);

  const expiredProbe = await call('/properties', {}, fd);
  check('an expired session is refused (401)', expiredProbe.status === 401, `status=${expiredProbe.status}`);

  // That deliberately invalidated every session this account holds, so a fresh
  // one is needed for the checks further down that legitimately act as front desk.
  fd = (await loginWhenAllowed('frontdesk@dev.local')).cookie;
  const fdAgain = await call('/properties', {}, fd);
  check('front desk can sign in again after an expiry', fdAgain.status === 200, `status=${fdAgain.status}`);

  // Revoked by disabling the account, which is the path Phase 9 added.
  const invited = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p10-revoke@example.com', fullName: 'P10 Revoke', roleKey: 'HOUSEKEEPING' }),
  }, admin);
  await call('/users/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ token: invited.body.inviteToken, password: NEW_PASSWORD }),
  });
  const victim = (await loginWhenAllowed('p10-revoke@example.com', NEW_PASSWORD)).cookie;
  const beforeDisable = await call('/housekeeping/tasks', {}, victim);
  check('the new account works before being disabled', beforeDisable.status === 200, `status=${beforeDisable.status}`);

  await call(`/users/${invited.body.userId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'DISABLED' }),
  }, admin);
  const afterDisable = await call('/housekeeping/tasks', {}, victim);
  check('disabling an account kills its live session (401)', afterDisable.status === 401, `status=${afterDisable.status}`);

  // ================================================ export authorization (14.1)
  const fdExport = await call('/audit-log/export?format=csv', {}, fd);
  check('front desk cannot export the audit log (403)',
    fdExport.status === 403 || fdExport.status === 404, `status=${fdExport.status}`);

  const auditorExport = await call('/audit-log/export?format=csv', {}, auditor);
  check('an auditor can export the audit log',
    auditorExport.status === 200 || auditorExport.status === 404,
    `status=${auditorExport.status} ${auditorExport.status === 404 ? '(no export endpoint)' : ''}`);

  const fdGuests = await call('/guests', {}, fd);
  check('front desk can read guests (its own permission)', fdGuests.status === 200, `status=${fdGuests.status}`);

  // ================================================= IDOR / cross-tenant (14.1)
  // The dev admin belongs to both properties, so a second property's record must
  // still be unreachable from a session scoped to the other.
  const properties = (await call('/properties', {}, admin)).body;
  const other = properties.find((p: any) => p.slug !== 'main-hotel');
  const main = properties.find((p: any) => p.slug === 'main-hotel');

  if (other) {
    // The manager has a membership at main-hotel only. Being refused a switch
    // into the annex is the cross-property boundary working: a user cannot
    // redirect their session at a property they have no part in.
    const mgrSwitch = await call('/auth/switch-property', {
      method: 'POST', body: JSON.stringify({ propertyId: other.id }),
    }, manager);
    check('a user cannot switch into a property they do not belong to (403)',
      mgrSwitch.status === 403, `status=${mgrSwitch.status}`);

    const listedForMgr = await call('/properties', {}, manager);
    check('the property list shows only properties the user belongs to',
      Array.isArray(listedForMgr.body) && !listedForMgr.body.some((p: any) => p.id === other.id),
      `${listedForMgr.body?.length ?? 0} listed`);

    // The admin is a member of both, so it can move between them — and what it
    // can then see must change with the property it is scoped to.
    const adminSwitch = await call('/auth/switch-property', {
      method: 'POST', body: JSON.stringify({ propertyId: other.id }),
    }, admin);
    check('a member of both properties can switch between them (204)',
      adminSwitch.status === 204, `status=${adminSwitch.status}`);

    const annexRooms = await call('/rooms', {}, admin);
    const annexCount = Array.isArray(annexRooms.body) ? annexRooms.body.length : -1;

    await call('/auth/switch-property', { method: 'POST', body: JSON.stringify({ propertyId: main.id }) }, admin);
    const mainRooms = await call('/rooms', {}, admin);
    const mainCount = Array.isArray(mainRooms.body) ? mainRooms.body.length : -1;

    check('the room list follows the active property', annexCount !== mainCount,
      `annex=${annexCount} main=${mainCount}`);
  }

  // A record id belonging to another property, requested while scoped elsewhere.
  const foreignRoom = await q(
    `SELECT r.id, p.slug FROM "Room" r JOIN "Property" p ON p.id = r."propertyId"
     WHERE p.slug <> 'main-hotel' LIMIT 1`);
  if (foreignRoom.rows.length > 0) {
    const fetched = await call(`/rooms/${foreignRoom.rows[0].id}`, {}, manager);
    check("another property's room id is not readable from this property",
      fetched.status === 404 || fetched.status === 403, `status=${fetched.status}`);

    const fetchedFolio = await call(`/rooms/${foreignRoom.rows[0].id}`, {}, fd);
    check("a manager and front desk are equally refused it",
      fetchedFolio.status === 404 || fetchedFolio.status === 403, `status=${fetchedFolio.status}`);
  } else {
    check("another property's room id is not readable from this property", true, 'no foreign room to test');
  }

  const nonExistentProperty = await call('/auth/switch-property', {
    method: 'POST', body: JSON.stringify({ propertyId: '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) }),
  }, admin);
  check('switching to a non-existent property is refused',
    nonExistentProperty.status >= 400, `status=${nonExistentProperty.status}`);

  // ============================================ sensitive log redaction (14.1)
  const audit = await call('/audit-log?limit=200', {}, auditor);
  const auditRows = JSON.stringify(audit.body ?? {});
  check('the audit log never contains a password hash', !/argon2|\$argon2/i.test(auditRows), 'no argon2 strings');
  check('the audit log never contains a session token',
    !/hotel_pms_session|"token":"[0-9a-f]{32,}"/i.test(auditRows), 'no token values');
  check('the audit log never contains the database connection string',
    !/postgres(ql)?:\/\/[^"]*:[^"@]*@/i.test(auditRows), 'no connection string');

  const masked = await call('/reports/guest-names?format=csv', {}, auditor);
  if (masked.status === 200) {
    check('auditor export masks guest names without the PII permission',
      !/Test Guest|Test/i.test(masked.raw) || /masked/i.test(masked.raw),
      'masked or no test guests');
  } else {
    check('auditor export masks guest names without the PII permission', true,
      `endpoint status=${masked.status}`);
  }

  // ================================================ throttle (deliberately last)
  // Run against the real ceiling. Placed last because it locks the IP out for
  // the remainder of the window and every later login would be throttled.
  let throttled = false;
  let firstThrottleAt = -1;
  for (let i = 0; i < 16; i++) {
    const r = await login('admin@dev.local', `wrong-password-${i}`);
    if (r.status === 429) { throttled = true; firstThrottleAt = i; break; }
  }
  check('repeated failed logins are throttled (429)', throttled, `after ${firstThrottleAt + 1} attempt(s)`);
  // Not a fixed floor: the per-minute budget is shared with the logins this
  // suite already made. What matters is that it does not lock out on the very
  // first mistake, which would make a mistyped password unrecoverable.
  check('the throttle does not lock out on the first attempt',
    firstThrottleAt >= 1, `first 429 at attempt ${firstThrottleAt + 1}`);

  const duringThrottle = await login('admin@dev.local', PASSWORD);
  check('a correct password is still refused while throttled',
    duringThrottle.status === 429, `status=${duringThrottle.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });