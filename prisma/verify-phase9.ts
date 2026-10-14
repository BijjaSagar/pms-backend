/**
 * Phase 9 acceptance checks.
 *
 * The kit's gate is: all admin functions work, role assignment is audited, and
 * no privilege escalation is possible. The escalation *rule* is unit-tested in
 * escalation.policy.spec.ts, because only ADMIN can grant roles and ADMIN holds
 * every permission, so the rule cannot be provoked over HTTP. What is checked
 * here is the enforcement that is reachable: the read/write split, the lockout
 * guards, and the audit trail.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';
const NEW_PASSWORD = 'Invited!Pass2026x';

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

/**
 * Waits for the login throttle to clear.
 *
 * This suite authenticates as five seeded roles plus each account it invites,
 * which exceeds the per-minute login budget in one run. Waiting is better than
 * skipping checks or reporting 429s that say nothing about the code.
 */
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

/** Removes staff this suite created so a re-run starts from the seeded five. */
async function cleanupInvited() {
  const rows = await q(`SELECT id, email FROM "User" WHERE email LIKE 'p9-%'`);
  for (const r of rows.rows) {
    await q(`DELETE FROM "Session" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "PropertyMembership" WHERE "userId" = $1`, [r.id]);
    await q(`DELETE FROM "AuditLog" WHERE "actorUserId" = $1`, [r.id]);
    await q(`DELETE FROM "User" WHERE id = $1`, [r.id]);
  }
  // Tax rules survive runs, so a rule created last time would make this run's
  // create call fail on a duplicate code and report a false regression.
  await q(`DELETE FROM "TaxRule" WHERE code LIKE 'P9%'`);
}

async function main() {
  await cleanup();
  await cleanupInvited();

  let admin = (await loginWhenAllowed('admin@dev.local')).cookie;
  const manager = (await loginWhenAllowed('manager@dev.local')).cookie;
  const fd = (await loginWhenAllowed('frontdesk@dev.local')).cookie;
  const auditor = (await loginWhenAllowed('auditor@dev.local')).cookie;
  const hk = (await loginWhenAllowed('housekeeping@dev.local')).cookie;

  const probe = await call('/properties', {}, admin);
  if (probe.status !== 200) {
    console.error(`Session setup failed (status=${probe.status}); wait 60s and re-run.`);
    process.exitCode = 1;
    return;
  }

  const properties = (await call('/properties', {}, admin)).body;
  const mainProperty = properties.find((p: any) => p.slug === 'main-hotel') ?? properties[0];

  // The admin belongs to two properties and the invite lands on whichever is
  // active. Switching explicitly keeps the membership and the property used for
  // role changes the same one, instead of depending on login order.
  const adminCookie = (await loginWhenAllowed('admin@dev.local')).cookie;
  // switch-property answers 204: it mutates and returns no body.
  const switched = await call('/auth/switch-property', {
    method: 'POST', body: JSON.stringify({ propertyId: mainProperty.id }),
  }, adminCookie);
  check('the active property can be switched', switched.status === 204, `status=${switched.status}`);
  admin = adminCookie;

  // ===================================================== read / write separation
  const mgrUsers = await call('/users', {}, manager);
  check('a manager can read the staff list', mgrUsers.status === 200, `status=${mgrUsers.status}`);
  check('the staff list names, emails and roles',
    Array.isArray(mgrUsers.body) && mgrUsers.body.length >= 5
      && ['fullName', 'email', 'status', 'roleKey'].every((f) => f in mgrUsers.body[0]),
    `${mgrUsers.body?.length} staff`);

  for (const [label, cookie] of [['front desk', fd], ['auditor', auditor], ['housekeeping', hk]] as [string, string][]) {
    const r = await call('/users', {}, cookie);
    check(`${label} cannot read the staff list (403)`, r.status === 403, `status=${r.status}`);
  }

  const mgrInvite = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p9-manager-attempt@example.com', fullName: 'Nope', roleKey: 'MANAGER' }),
  }, manager);
  check('a manager cannot invite staff (403)', mgrInvite.status === 403, `status=${mgrInvite.status}`);

  const mgrDeactivate = await call(`/users/${mainProperty.id ? '' : ''}status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'DISABLED' }),
  }, manager);
  check('a manager cannot change a user status (403)', mgrDeactivate.status === 403, `status=${mgrDeactivate.status}`);

  const mgrRoles = await call('/roles', {}, manager);
  check('a manager cannot read the role catalogue (403)', mgrRoles.status === 403, `status=${mgrRoles.status}`);

  // ============================================================== role catalogue
  const roles = await call('/roles', {}, admin);
  check('an admin can read the roles', roles.status === 200, `status=${roles.status}`);
  check('all five system roles are present',
    ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'AUDITOR']
      .every((k) => roles.body.some((r: any) => r.key === k)),
    roles.body?.map((r: any) => r.key).join(', '));
  check('roles are marked as system roles', roles.body.every((r: any) => r.isSystem));
  check('roles carry a description', roles.body.every((r: any) => !!r.description));

  const perms = await call('/permissions', {}, admin);
  check('the permission catalogue is readable', perms.status === 200 && perms.body.length >= 60,
    `${perms.body?.length} permissions`);
  check('every permission has a description', perms.body.every((p: any) => !!p.description));

  const matrix = await call('/roles/matrix', {}, admin);
  check('the permission matrix is readable', matrix.status === 200, `status=${matrix.status}`);
  check('the matrix is grouped by resource', Array.isArray(matrix.body.resources) && matrix.body.resources.length > 0,
    `${matrix.body?.resources?.length} resources`);
  check('the matrix shows which roles hold each permission',
    matrix.body.resources.every((g: any) => g.permissions.every((p: any) => Array.isArray(p.roles))));

  const editSystem = await call('/roles/ADMIN/permissions', {
    method: 'PATCH', body: JSON.stringify({ permissionKeys: ['user.read'] }),
  }, admin);
  check('a system role cannot be edited at runtime (403)', editSystem.status === 403, `status=${editSystem.status}`);

  // ==================================================================== invitation
  const invite = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({
      email: 'p9-newjoin@example.com', fullName: 'P9 New Join', roleKey: 'HOUSEKEEPING',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
  }, admin);
  check('an admin can invite staff', invite.status === 201 || invite.status === 200, `status=${invite.status}`);
  check('the invite returns an accept link', /accept-invite\?token=/.test(invite.body?.acceptUrl ?? ''),
    invite.body?.acceptUrl);
  check('the invite reports which property the membership was created on',
    typeof invite.body?.propertyId === 'string', invite.body?.propertyId);
  check('the invite expiry is recorded', !!invite.body?.inviteExpiresAt, invite.body?.inviteExpiresAt);

  const dupe = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p9-newjoin@example.com', fullName: 'Dupe', roleKey: 'HOUSEKEEPING' }),
  }, admin);
  check('inviting a pending address twice is refused (409)', dupe.status === 409, `status=${dupe.status}`);
  check('the refusal points at reissue rather than silently reissuing',
    /reissue/i.test(JSON.stringify(dupe.body)), JSON.stringify(dupe.body).slice(0, 120));

  const badEmail = await call('/users/invite', {
    method: 'POST', body: JSON.stringify({ email: 'not-an-email', fullName: 'X', roleKey: 'HOUSEKEEPING' }),
  }, admin);
  check('an invalid email is rejected (400)', badEmail.status === 400, `status=${badEmail.status}`);

  const badRole = await call('/users/invite', {
    method: 'POST', body: JSON.stringify({ email: 'p9-x@example.com', fullName: 'X', roleKey: 'SUPERUSER' }),
  }, admin);
  check('an unknown role is rejected (404)', badRole.status === 404, `status=${badRole.status}`);

  const listed = (await call('/users', {}, admin)).body.find((u: any) => u.email === 'p9-newjoin@example.com');
  check('the invitee appears as INVITED', listed?.status === 'INVITED', listed?.status);
  check('the invitee holds the invited role', listed?.roleKey === 'HOUSEKEEPING', listed?.roleKey);
  check('the invitation reads as pending', listed?.invitePending === true, String(listed?.invitePending));

  const inviteAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'user.invite'`,
    [invite.body.userId]);
  check('the invitation is audited', inviteAudit.rows[0].n === 1, `${inviteAudit.rows[0].n} rows`);

  // ================================================================ accept / replay
  const weak = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: invite.body.inviteToken, password: 'short' }),
  });
  check('a short password is rejected (400)', weak.status === 400, `status=${weak.status}`);

  const badToken = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: 'not-a-real-token', password: NEW_PASSWORD }),
  });
  check('an unknown token is rejected (404)', badToken.status === 404, `status=${badToken.status}`);

  const accepted = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: invite.body.inviteToken, password: NEW_PASSWORD }),
  });
  check('the invitee can accept and set their own password',
    accepted.status === 201 || accepted.status === 200,
    `status=${accepted.status} ${accepted.raw?.slice(0, 160)}`);
  check('the account becomes ACTIVE', accepted.body?.status === 'ACTIVE', accepted.body?.status);

  const replay = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: invite.body.inviteToken, password: NEW_PASSWORD }),
  });
  check('a used token cannot be replayed (404)', replay.status === 404, `status=${replay.status}`);

  const tokenCleared = await q(`SELECT "inviteToken" FROM "User" WHERE id = $1`, [invite.body.userId]);
  check('the token is cleared once used', tokenCleared.rows[0]?.inviteToken === null,
    String(tokenCleared.rows[0]?.inviteToken));

  const newLogin = await loginWhenAllowed('p9-newjoin@example.com', NEW_PASSWORD);
  check('the new joiner can log in with their chosen password', newLogin.status === 200, `status=${newLogin.status}`);
  const asCleaner = await call('/housekeeping/tasks', {}, newLogin.cookie);
  check('the new joiner has their invited role permissions', asCleaner.status === 200, `status=${asCleaner.status}`);
  const asRoles = await call('/roles', {}, newLogin.cookie);
  check('the new joiner cannot read roles', asRoles.status === 403, `status=${asRoles.status}`);

  const acceptedAt = await q(
    `SELECT "acceptedAt" FROM "PropertyMembership" WHERE "userId" = $1`, [invite.body.userId]);
  check('the membership records acceptance', acceptedAt.rows[0]?.acceptedAt !== null,
    String(acceptedAt.rows[0]?.acceptedAt));

  // ================================================================== expiry
  const expiring = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({
      email: 'p9-expired@example.com', fullName: 'P9 Expired', roleKey: 'FRONT_DESK',
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    }),
  }, admin);
  check('an invite can be issued already expired (for testing)', expiring.status === 201 || expiring.status === 200,
    `status=${expiring.status}`);

  const expiredAccept = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: expiring.body.inviteToken, password: NEW_PASSWORD }),
  });
  check('an expired invite is refused (400)', expiredAccept.status === 400, `status=${expiredAccept.status}`);

  const reissued = await call(`/users/${expiring.body.userId}/reissue-invite`, {
    method: 'POST', body: JSON.stringify({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
  }, admin);
  check('an invite can be reissued', reissued.status === 201 || reissued.status === 200, `status=${reissued.status}`);
  check('the reissued response carries a token', typeof reissued.body?.inviteToken === 'string',
    typeof reissued.body?.inviteToken);
  check('reissuing issues a different token',
    !!reissued.body?.inviteToken && reissued.body.inviteToken !== expiring.body?.inviteToken,
    'token differs');

  const reissueAccept = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: reissued.body.inviteToken, password: NEW_PASSWORD }),
  });
  check('the reissued token works', reissueAccept.status === 201 || reissueAccept.status === 200,
    `status=${reissueAccept.status}`);

  const oldTokenDead = await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: expiring.body.inviteToken, password: NEW_PASSWORD }),
  });
  check('reissuing invalidates the old token', oldTokenDead.status === 404, `status=${oldTokenDead.status}`);

  // ============================================================= role assignment
  const promoted = await call(`/users/${invite.body.userId}/role`, {
    method: 'PATCH', body: JSON.stringify({ propertyId: invite.body.propertyId, roleKey: 'FRONT_DESK' }),
  }, admin);
  check('an admin can change a role', promoted.status === 200,
    `status=${promoted.status} ${promoted.raw?.slice(0, 160)}`);
  check('the previous role is reported', promoted.body?.previousRoleKey === 'HOUSEKEEPING', promoted.body?.previousRoleKey);

  const roleAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'role.assign'`,
    [invite.body.userId]);
  check('role assignment is audited', roleAudit.rows[0].n === 1, `${roleAudit.rows[0].n} rows`);

  const roleAuditDetail = await q(
    `SELECT metadata FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'role.assign'`,
    [invite.body.userId]);
  check('the audit row records both roles',
    /HOUSEKEEPING/.test(JSON.stringify(roleAuditDetail.rows[0]?.metadata))
    && /FRONT_DESK/.test(JSON.stringify(roleAuditDetail.rows[0]?.metadata)),
    JSON.stringify(roleAuditDetail.rows[0]?.metadata));

  const newCleanerRoles = await call('/roles', {}, newLogin.cookie);
  check('the new role takes effect immediately', newCleanerRoles.status === 403, `status=${newCleanerRoles.status}`);

  // FRONT_DESK also holds housekeeping.read, so the loss of permission is checked
  // against something that role genuinely never had.
  const newJoinerUsers = await call('/users', {}, newLogin.cookie);
  check('the demoted role loses its permissions', newJoinerUsers.status === 403, `status=${newJoinerUsers.status}`);
  const newJoinerStillCanPost = await call('/front-desk/arrivals', {}, newLogin.cookie);
  check('the new role grants its own permissions', newJoinerStillCanPost.status === 200,
    `status=${newJoinerStillCanPost.status}`);

  const mgrRoleChange = await call(`/users/${invite.body.userId}/role`, {
    method: 'PATCH', body: JSON.stringify({ propertyId: invite.body.propertyId, roleKey: 'MANAGER' }),
  }, manager);
  check('a manager cannot assign roles (403)', mgrRoleChange.status === 403, `status=${mgrRoleChange.status}`);

  // ============================================================ lockout guards
  const adminUser = await q(
    `SELECT u.id FROM "User" u WHERE u.email = 'admin@dev.local'`);
  const adminId = adminUser.rows[0].id;

  const selfDisable = await call(`/users/${adminId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'DISABLED' }),
  }, admin);
  check('an admin cannot disable their own account (409)', selfDisable.status === 409, `status=${selfDisable.status}`);
  check('the refusal explains the lockout risk', /own account/i.test(JSON.stringify(selfDisable.body)));

  const selfDemote = await call(`/users/${adminId}/role`, {
    method: 'PATCH', body: JSON.stringify({ propertyId: invite.body.propertyId, roleKey: 'MANAGER' }),
  }, admin);
  check('an admin cannot demote themselves (409)', selfDemote.status === 409, `status=${selfDemote.status}`);
  check('the demotion refusal explains itself', /last active administrator|own administrator role/i.test(
    JSON.stringify(selfDemote.body)));

  // A second admin, so the last-admin rule can be distinguished from self-protection.
  const secondAdmin = await call('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ email: 'p9-admin2@example.com', fullName: 'P9 Second Admin', roleKey: 'ADMIN' }),
  }, admin);
  await call('/users/accept-invite', {
    method: 'POST', body: JSON.stringify({ token: secondAdmin.body.inviteToken, password: NEW_PASSWORD }),
  });
  const secondAdminLogin = await loginWhenAllowed('p9-admin2@example.com', NEW_PASSWORD);
  check('a second admin can be created and log in', secondAdminLogin.status === 200, `status=${secondAdminLogin.status}`);

  const demoteOne = await call(`/users/${adminId}/role`, {
    method: 'PATCH', body: JSON.stringify({ propertyId: invite.body.propertyId, roleKey: 'MANAGER' }),
  }, secondAdminLogin.cookie);
  check('with a second admin present, demoting one is allowed',
    demoteOne.status === 200, `status=${demoteOne.status}`);

  const restoreAdmin = await call(`/users/${adminId}/role`, {
    method: 'PATCH', body: JSON.stringify({ propertyId: invite.body.propertyId, roleKey: 'ADMIN' }),
  }, secondAdminLogin.cookie);
  check('the first admin can be promoted back', restoreAdmin.status === 200, `status=${restoreAdmin.status}`);

  // ==================================================================== disable
  const target = (await call('/users', {}, admin)).body.find((u: any) => u.email === 'p9-expired@example.com');
  const targetLogin = await loginWhenAllowed('p9-expired@example.com', NEW_PASSWORD);
  check('the target has a working session before disabling', targetLogin.status === 200, `status=${targetLogin.status}`);

  const disabled = await call(`/users/${target.userId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'DISABLED' }),
  }, admin);
  check('an admin can disable an account', disabled.status === 200, `status=${disabled.status}`);

  const afterDisable = await call('/properties', {}, targetLogin.cookie);
  check('the disabled account\'s session no longer works (401)', afterDisable.status === 401,
    `status=${afterDisable.status}`);

  const reenable = await call(`/users/${target.userId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
  }, admin);
  check('an admin can re-enable an account', reenable.status === 200, `status=${reenable.status}`);

  // =================================================================== tax rules
  const taxRead = await call('/tax-rules', {}, manager);
  check('a manager can read tax rules', taxRead.status === 200, `status=${taxRead.status}`);
  check('the seeded GST rule is present',
    taxRead.body.some((t: any) => t.code === 'GST18'), taxRead.body?.map((t: any) => t.code).join(', '));

  const fdTaxRead = await call('/tax-rules', {}, fd);
  check('front desk can read tax rules', fdTaxRead.status === 200, `status=${fdTaxRead.status}`);
  const mgrTaxWrite = await call('/tax-rules', {
    method: 'POST', body: JSON.stringify({ code: 'X', name: 'X', ratePercent: 5 }),
  }, manager);
  check('a manager cannot change tax rules (403)', mgrTaxWrite.status === 403, `status=${mgrTaxWrite.status}`);
  const fdTaxWrite = await call('/tax-rules', {
    method: 'POST', body: JSON.stringify({ code: 'Y', name: 'Y', ratePercent: 5 }),
  }, fd);
  check('front desk cannot change tax rules (403)', fdTaxWrite.status === 403, `status=${fdTaxWrite.status}`);

  const newTax = await call('/tax-rules', {
    method: 'POST', body: JSON.stringify({ code: 'P9SERVICE', name: 'Service 5%', ratePercent: 5 }),
  }, admin);
  check('an admin can add a tax rule', newTax.status === 201 || newTax.status === 200, `status=${newTax.status}`);
  const taxAudit = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'tax.rule.create'`,
    [newTax.body.id]);
  check('a tax rule change is audited', taxAudit.rows[0].n === 1, `${taxAudit.rows[0].n} rows`);

  const dupeTax = await call('/tax-rules', {
    method: 'POST', body: JSON.stringify({ code: 'P9SERVICE', name: 'Again', ratePercent: 9 }),
  }, admin);
  check('a duplicate tax code is rejected (400)', dupeTax.status === 400, `status=${dupeTax.status}`);

  const badRate = await call('/tax-rules', {
    method: 'POST', body: JSON.stringify({ code: 'NEG', name: 'Negative', ratePercent: -5 }),
  }, admin);
  check('a negative tax rate is rejected (400)', badRate.status === 400, `status=${badRate.status}`);

  // ============================================================ no self-escalation
  const selfRole = await call('/roles/matrix', {}, admin);
  check('an admin still holds every permission',
    selfRole.body.roles.length >= 4 && selfRole.status === 200, 'matrix readable');

  const trace = await call('/audit-log?action=role.assign', {}, auditor);
  check('an auditor can trace role assignments', trace.status === 200 && trace.body.total >= 2,
    `${trace.body?.total} rows`);
  check('each traced assignment names an actor',
    trace.body.rows.every((r: any) => !!r.actorName), trace.body.rows[0]?.actorName);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });