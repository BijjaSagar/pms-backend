/**
 * Phase 2A acceptance checks against a running backend.
 * Run with the API on http://localhost:3000.
 */
import { pinProperty } from './cleanup-test-data.js';
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, setCookie };
}

const cookieValue = (setCookie: string | null) => setCookie?.split(';')[0] ?? '';

async function login(email: string) {
  const r = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { status: r.status, cookie: cookieValue(r.setCookie), body: r.body };
}

const me_ = (cookie: string) => call('/auth/me', { headers: { cookie } });

async function main() {
  // --- admin happy path ---
  const admin = await login('admin@dev.local');
  await pinProperty(admin);
  check('login sets a session cookie', admin.cookie.includes('hotel_pms_session'));
  check('login returns 200', admin.status === 200, `status=${admin.status}`);

  const me = await me_(admin.cookie);
  check('GET /auth/me returns 200', me.status === 200, `status=${me.status}`);
  check('/auth/me identifies the user', me.body?.user?.email === 'admin@dev.local');
  check('/auth/me resolves an active property', !!me.body?.activePropertyId);
  check(
    '/auth/me returns 63 permissions for ADMIN',
    me.body?.permissions?.length === 63,
    `${me.body?.permissions?.length}`,
  );
  check(
    '/auth/me nests role and property on memberships',
    !!me.body?.user?.propertyMemberships?.[0]?.role?.key &&
      !!me.body?.user?.propertyMemberships?.[0]?.property?.name,
    `role=${me.body?.user?.propertyMemberships?.[0]?.role?.key}`,
  );
  check(
    'admin has memberships on 2 properties',
    me.body?.user?.propertyMemberships?.length === 2,
    `${me.body?.user?.propertyMemberships?.length}`,
  );

  // --- rejection paths ---
  check('/auth/me without a session is 401', (await me_('')).status === 401);

  const unknown = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@dev.local', password: 'WrongPassword!1' }),
  });
  check('unknown email is 401', unknown.status === 401, `status=${unknown.status}`);

  const wrongPw = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@dev.local', password: 'WrongPassword!1' }),
  });
  check('wrong password is 401', wrongPw.status === 401, `status=${wrongPw.status}`);
  check(
    'unknown email and wrong password are indistinguishable',
    wrongPw.body?.message === unknown.body?.message,
    JSON.stringify(wrongPw.body?.message),
  );

  // --- per-role permission shaping ---
  const hk = await login('housekeeping@dev.local');
  const hkMe = await me_(hk.cookie);
  check('housekeeping resolves 10 permissions', hkMe.body?.permissions?.length === 10, `${hkMe.body?.permissions?.length}`);
  check(
    'housekeeping has no guest.* permission',
    !(hkMe.body?.permissions ?? []).some((p: string) => p.startsWith('guest.')),
  );

  const auditor = await login('auditor@dev.local');
  const audMe = await me_(auditor.cookie);
  check('auditor resolves 15 permissions', audMe.body?.permissions?.length === 15, `${audMe.body?.permissions?.length}`);
  check(
    'auditor has audit-log.read but not audit-log.export',
    audMe.body?.permissions?.includes('audit-log.read') && !audMe.body?.permissions?.includes('audit-log.export'),
  );

  // --- switching among properties the user owns ---
  const annexId = me.body?.user?.propertyMemberships?.find(
    (m: any) => m.property.slug === 'annex-property',
  )?.propertyId;

  const allowedSwitch = await call('/auth/switch-property', {
    method: 'POST',
    headers: { cookie: admin.cookie },
    body: JSON.stringify({ propertyId: annexId }),
  });
  check('admin can switch to annex-property', allowedSwitch.status === 204, `status=${allowedSwitch.status}`);

  const afterSwitch = await me_(admin.cookie);
  check('active property persisted across requests', afterSwitch.body?.activePropertyId === annexId);
  check(
    'permissions re-resolved after switching',
    afterSwitch.body?.permissions?.length === 63,
    `${afterSwitch.body?.permissions?.length}`,
  );

  // --- cross-property isolation, reusing ONE front-desk session ---
  const fd = await login('frontdesk@dev.local');
  check('front desk login succeeded', fd.status === 200, `status=${fd.status}`);

  const fdMe = await me_(fd.cookie);
  check(
    'front desk has exactly 1 membership',
    fdMe.body?.user?.propertyMemberships?.length === 1,
    `${fdMe.body?.user?.propertyMemberships?.length}`,
  );

  const forbidden = await call('/auth/switch-property', {
    method: 'POST',
    headers: { cookie: fd.cookie },
    body: JSON.stringify({ propertyId: annexId }),
  });
  check(
    'front desk cannot switch to a property it does not belong to',
    forbidden.status === 403,
    `status=${forbidden.status}`,
  );

  const stillMain = await me_(fd.cookie);
  check(
    'denied switch left the active property unchanged',
    stillMain.body?.activePropertyId !== annexId && !!stillMain.body?.activePropertyId,
  );

  // --- logout revokes server-side, same session ---
  check('session works before logout', (await me_(fd.cookie)).status === 200);
  const logout = await call('/auth/logout', { method: 'POST', headers: { cookie: fd.cookie } });
  check('logout returns 204', logout.status === 204, `status=${logout.status}`);
  check(
    'replaying the revoked cookie is rejected',
    (await me_(fd.cookie)).status === 401,
  );

  // --- login throttling, checked last because it consumes the request budget ---
  let sawThrottle = false;
  for (let i = 0; i < 10; i++) {
    const r = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'manager@dev.local', password: 'WrongPassword!1' }),
    });
    if (r.status === 429) {
      sawThrottle = true;
      break;
    }
  }
  check('repeated bad logins are throttled with 429', sawThrottle);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('verification error:', e);
  process.exitCode = 1;
});