/**
 * Phase 10 RBAC matrix verification.
 *
 * Section 14 requires, for every permission family, "at least one allowed and
 * multiple denied scenarios per role", and separately that the same request is
 * denied when issued without permission "even if the frontend is manipulated".
 * This walks one representative endpoint per permission and checks all five
 * roles against it.
 *
 * Two design points worth stating:
 *
 *  - Expected permissions are read from the database rather than hardcoded, so
 *    the matrix cannot quietly agree with a broken seed. If a grant is wrong,
 *    this test follows it and the permission suite catches the real drift.
 *
 *  - Write endpoints are called with an empty body. Guards run before the
 *    validation pipe in Nest's lifecycle, so a denied request returns 403 before
 *    the body is even inspected, while an allowed one falls through to a 400.
 *    That makes the whole matrix side-effect free: nothing is actually created.
 *
 * The assertion is "403 means denied", never "2xx means allowed" — a role can
 * hold a permission and still get a 400 or 404 for reasons that have nothing to
 * do with authorisation, and treating that as a failure would test the wrong
 * thing.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

const ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'AUDITOR'] as const;
const EMAILS: Record<string, string> = {
  ADMIN: 'admin@dev.local',
  MANAGER: 'manager@dev.local',
  FRONT_DESK: 'frontdesk@dev.local',
  HOUSEKEEPING: 'housekeeping@dev.local',
  AUDITOR: 'auditor@dev.local',
};

/** One endpoint per permission, including the two that need a permission pair. */
const ENDPOINTS: { method: string; path: string; required: string[]; label: string }[] = [
  { method: 'GET', path: '/properties', required: ['property.read'], label: 'property.read' },
  { method: 'GET', path: '/room-types', required: ['room.read'], label: 'room.read' },
  { method: 'GET', path: '/rooms', required: ['room.read'], label: 'room.read (rooms)' },
  { method: 'POST', path: '/rooms', required: ['room.create'], label: 'room.create' },
  { method: 'PATCH', path: '/rooms/00000000-0000-0000-0000-000000000000', required: ['room.update'], label: 'room.update' },
  { method: 'GET', path: '/guests', required: ['guest.read'], label: 'guest.read' },
  { method: 'POST', path: '/guests', required: ['guest.create'], label: 'guest.create' },
  { method: 'GET', path: '/reservations', required: ['reservation.read'], label: 'reservation.read' },
  { method: 'POST', path: '/reservations', required: ['reservation.create'], label: 'reservation.create' },
  { method: 'PATCH', path: '/reservations/00000000-0000-0000-0000-000000000000', required: ['reservation.update'], label: 'reservation.update' },
  { method: 'POST', path: '/reservations/00000000-0000-0000-0000-000000000000/assign-room', required: ['reservation.assign-room'], label: 'reservation.assign-room' },
  { method: 'POST', path: '/reservations/00000000-0000-0000-0000-000000000000/cancel', required: ['reservation.cancel'], label: 'reservation.cancel' },
  { method: 'GET', path: '/housekeeping/tasks', required: ['housekeeping.read'], label: 'housekeeping.read' },
  { method: 'POST', path: '/housekeeping/tasks', required: ['housekeeping.assign'], label: 'housekeeping.assign' },
  { method: 'POST', path: '/housekeeping/tasks/00000000-0000-0000-0000-000000000000/start', required: ['housekeeping.start'], label: 'housekeeping.start' },
  { method: 'POST', path: '/housekeeping/tasks/00000000-0000-0000-0000-000000000000/complete', required: ['housekeeping.complete'], label: 'housekeeping.complete' },
  { method: 'POST', path: '/housekeeping/tasks/00000000-0000-0000-0000-000000000000/inspect', required: ['housekeeping.inspect'], label: 'housekeeping.inspect' },
  { method: 'GET', path: '/maintenance/tickets', required: ['maintenance.read'], label: 'maintenance.read' },
  { method: 'POST', path: '/maintenance/tickets', required: ['maintenance.create'], label: 'maintenance.create' },
  { method: 'PATCH', path: '/maintenance/tickets/00000000-0000-0000-0000-000000000000/assign', required: ['maintenance.assign'], label: 'maintenance.assign' },
  { method: 'POST', path: '/maintenance/tickets/00000000-0000-0000-0000-000000000000/resolve', required: ['maintenance.resolve'], label: 'maintenance.resolve' },
  { method: 'POST', path: '/rooms/00000000-0000-0000-0000-000000000000/out-of-order', required: ['room.out-of-order'], label: 'room.out-of-order' },
  { method: 'GET', path: '/reports/daily-flash', required: ['report.read.operations'], label: 'report.read.operations' },
  { method: 'GET', path: '/reports/revenue', required: ['report.read.financial'], label: 'report.read.financial' },
  // Pair requirement: reading the report is not enough, exporting it is a
  // separate decision. A role holding only the read half must still be refused.
  { method: 'GET', path: '/reports/occupancy/export.csv', required: ['report.read.operations', 'report.export'], label: 'report.export (with read)' },
  { method: 'GET', path: '/night-audit/2026-01-01', required: ['night-audit.read'], label: 'night-audit.read' },
  { method: 'POST', path: '/night-audit/2026-01-01/preview', required: ['night-audit.run'], label: 'night-audit.run' },
  { method: 'POST', path: '/night-audit/2026-01-01/close', required: ['night-audit.approve'], label: 'night-audit.approve' },
  { method: 'GET', path: '/audit-log', required: ['audit-log.read'], label: 'audit-log.read' },
  { method: 'GET', path: '/audit-log/export.csv', required: ['audit-log.export'], label: 'audit-log.export' },
  { method: 'GET', path: '/users', required: ['user.read'], label: 'user.read' },
  { method: 'POST', path: '/users/invite', required: ['user.invite'], label: 'user.invite' },
  { method: 'PATCH', path: '/users/00000000-0000-0000-0000-000000000000', required: ['user.update'], label: 'user.update' },
  { method: 'PATCH', path: '/users/00000000-0000-0000-0000-000000000000/role', required: ['role.assign'], label: 'role.assign' },
  { method: 'PATCH', path: '/users/00000000-0000-0000-0000-000000000000/status', required: ['user.deactivate'], label: 'user.deactivate' },
  { method: 'GET', path: '/roles', required: ['role.read'], label: 'role.read' },
  { method: 'PATCH', path: '/roles/ADMIN/permissions', required: ['role.manage'], label: 'role.manage' },
  { method: 'GET', path: '/tax-rules', required: ['invoice.read'], label: 'invoice.read (tax)' },
  { method: 'POST', path: '/tax-rules', required: ['role.manage'], label: 'tax-config mutation' },
];

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) console.log(`FAIL ${n}${d ? '  -> ' + d : ''}`);
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
  return { status: res.status, raw: text };
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

async function main() {
  await cleanup();

  // Authoritative grants, straight from the seed.
  const grants = await q(
    `SELECT r.key AS role, p.key AS permission
     FROM "Role" r
     JOIN "RolePermission" rp ON rp."roleId" = r.id
     JOIN "Permission" p ON p.id = rp."permissionId"`);

  const byRole = new Map<string, Set<string>>(ROLES.map((r) => [r, new Set<string>()]));
  for (const row of grants.rows) {
    byRole.get(row.role)?.add(row.permission);
  }

  const cookies = new Map<string, string>();
  for (const role of ROLES) {
    const r = await loginWhenAllowed(EMAILS[role]);
    if (!r.cookie) {
      console.error(`Could not sign in as ${role}; wait 60s and re-run.`);
      process.exitCode = 1;
      return;
    }
    cookies.set(role, r.cookie);
  }

  // Every role needs an active property or the guard answers 401 before it ever
  // reaches the permission check, which would make every row look "denied".
  for (const role of ROLES) {
    await pinProperty(cookies.get(role)!);
  }

  let throttled = 0;
  const families = new Set<string>();
  let allowedTotal = 0;
  let deniedTotal = 0;

  for (const endpoint of ENDPOINTS) {
    families.add(endpoint.required.join('+'));
    for (const role of ROLES) {
      const held = byRole.get(role)!;
      // The guard requires every listed permission.
      const shouldBeAllowed = endpoint.required.every((p) => held.has(p));

      const res = await call(
        endpoint.path,
        { method: endpoint.method, body: endpoint.method === 'GET' ? undefined : '{}' },
        cookies.get(role)!,
      );

      if (res.status === 429) { throttled++; continue; }

      const wasDenied = res.status === 403;
      if (shouldBeAllowed) {
        allowedTotal++;
        check(
          `${role} may ${endpoint.label}`,
          !wasDenied,
          `expected to pass the guard, got 403`,
        );
      } else {
        deniedTotal++;
        check(
          `${role} may not ${endpoint.label}`,
          wasDenied,
          `expected 403, got ${res.status}`,
        );
      }
    }
  }

  console.log(`\nEndpoints: ${ENDPOINTS.length}, roles: ${ROLES.length}, ` +
    `permission combinations: ${allowedTotal + deniedTotal}`);
  console.log(`Allowed as expected: ${allowedTotal}, denied as expected: ${deniedTotal}` +
    (throttled ? `, skipped (throttled): ${throttled}` : ''));
  console.log(`Permission families covered: ${families.size}`);

  if (throttled > 0) {
    console.error(`\n${throttled} checks were throttled and prove nothing. ` +
      `Re-run standalone, or raise RATE_LIMIT_PER_MINUTE for this run.`);
    process.exitCode = 1;
  }

  // Section 14 asks for "multiple denied scenarios per role", so a role that
  // could reach everything would pass every row above and still be useless.
  // ADMIN is the deliberate exception — it is the administrator of the
  // deployment and is meant to reach everything, so it is asserted the other
  // way round rather than being held to a limit it should never have.
  for (const role of ROLES) {
    const held = byRole.get(role)!;
    const unreachable = ENDPOINTS.filter((e) => !e.required.every((p) => held.has(p)));
    if (role === 'ADMIN') {
      check('the admin is refused nothing', unreachable.length === 0,
        `${unreachable.length} refused`);
    } else {
      check(`${role} is refused at multiple endpoints`, unreachable.length >= 2,
        `${unreachable.length}/${ENDPOINTS.length} refused`);
    }
  }

  const adminHeld = byRole.get('ADMIN')!;
  const everyPermission = new Set<string>();
  for (const role of byRole.keys()) for (const p of byRole.get(role)!) everyPermission.add(p);
  check('the admin holds every permission in the catalogue', everyPermission.size > 0
    && [...everyPermission].every((p) => adminHeld.has(p)),
    `${adminHeld.size}/${everyPermission.size}`);

  const housekeeperHeld = byRole.get('HOUSEKEEPING')!;
  check('housekeeping cannot reach finance or staff administration',
    !housekeeperHeld.has('folio.read') && !housekeeperHeld.has('user.read')
      && !housekeeperHeld.has('report.read.financial'),
    'isolated from money and staff');

  const auditorHeld = byRole.get('AUDITOR')!;
  check('the auditor holds read permissions but no mutating ones',
    auditorHeld.has('folio.read') && auditorHeld.has('audit-log.read')
      && !auditorHeld.has('folio.item.post') && !auditorHeld.has('reservation.create')
      && !auditorHeld.has('stay.check-out'),
    'read-only as specified');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });