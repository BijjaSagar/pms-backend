import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const KIT = join(dirname(fileURLToPath(import.meta.url)), 'seed.ts');

const ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'AUDITOR'] as const;
type Role = (typeof ROLES)[number];

/** Extract quoted permission keys from a bracket-delimited literal. */
function keysIn(literal: string): string[] {
  return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Parse the kit's rolePermissions, expanding ADMIN's spread of fullOperational. */
function parseKit(): Map<Role, Set<string>> {
  const src = readFileSync(KIT, 'utf8');

  // fullOperational is a named array referenced by ADMIN via spread.
  const foStart = src.indexOf('const fullOperational');
  const foBlock = src.slice(foStart, src.indexOf('const rolePermissions'));
  const fullOperational = new Set(keysIn(foBlock));

  // Each other role is a literal array: KEY: [ 'a', 'b' ],
  const rpStart = src.indexOf('const rolePermissions');
  const rpBlock = src.slice(rpStart, src.indexOf('async function main'));

  const out = new Map<Role, Set<string>>();
  for (const role of ROLES) {
    if (role === 'ADMIN') {
      out.set(role, fullOperational);
      continue;
    }
    const at = rpBlock.indexOf(`${role}: [`);
    if (at === -1) throw new Error(`kit: role ${role} not found`);
    const start = rpBlock.indexOf('[', at);
    const end = rpBlock.indexOf(']', start);
    out.set(role, new Set(keysIn(rpBlock.slice(start, end))));
  }
  return out;
}

async function main() {
  const kit = parseKit();
  const c = await pool.connect();
  let failures = 0;
  const fail = (m: string) => { failures++; console.log(`FAIL ${m}`); };
  try {
    const live = await c.query(
      `SELECT r.key, p.key AS perm FROM "Role" r
       JOIN "RolePermission" rp ON rp."roleId" = r.id
       JOIN "Permission" p ON p.id = rp."permissionId"
       ORDER BY r.key, p.key`,
    );
    const db = new Map<string, Set<string>>();
    for (const row of live.rows) {
      if (!db.has(row.key)) db.set(row.key, new Set());
      db.get(row.key)!.add(row.perm);
    }

    console.log('=== 1.3a: role -> permission parity vs kit rbac-seed.ts ===');
    for (const role of ROLES) {
      const k = kit.get(role)!;
      const d = db.get(role) ?? new Set<string>();
      const missing = [...k].filter((x) => !d.has(x));
      const extra = [...d].filter((x) => !k.has(x));
      if (missing.length || extra.length) {
        fail(`${role} kit=${k.size} db=${d.size}`);
        if (missing.length) console.log('   missing in DB:', missing.join(', '));
        if (extra.length) console.log('   extra in DB  :', extra.join(', '));
      } else {
        console.log(`PASS ${role.padEnd(12)} kit=${String(k.size).padStart(2)} db=${String(d.size).padStart(2)}  (exact match)`);
      }
    }

    const sumKit = ROLES.reduce((a, r) => a + kit.get(r)!.size, 0);
    const sumDb = live.rowCount;
    if (sumKit !== sumDb) fail(`RolePermission total kit_sum=${sumKit} db=${sumDb}`);
    else console.log(`PASS RolePermission total = ${sumDb} (matches kit sum exactly)`);

    const catalog = await c.query(`SELECT count(*)::int AS n FROM "Permission"`);
    if (catalog.rows[0].n !== 63) fail(`catalog size ${catalog.rows[0].n} != 63`);
    else console.log(`PASS permission catalog = 63 keys`);

    console.log('\n=== 1.3b: kit-mandated role asymmetries ===');
    const has = (role: string, p: string) => db.get(role)?.has(p) ?? false;
    const permsOf = (role: string) => [...(db.get(role) ?? [])];
    // Self-service grants the kit explicitly allows on every role.
    const SELF = new Set(['profile.update', 'theme.update']);
    const WRITE_RE = /\.(create|update|cancel|post|void|assign|record|resolve|complete|start|issue|run|approve|deactivate|reopen|check-in|check-out|out-of-order|status|pii|adjust|override)$/;

    const checks: Array<[string, boolean]> = [
      ['MANAGER: folio.item.adjust YES, folio.item.void NO', has('MANAGER','folio.item.adjust') && !has('MANAGER','folio.item.void')],
      ['MANAGER: NO payment.refund', !has('MANAGER','payment.refund')],
      ['MANAGER: NO folio.reopen / invoice.void', !has('MANAGER','folio.reopen') && !has('MANAGER','invoice.void')],
      ['FRONT_DESK: NO folio.item.void / folio.reopen', !has('FRONT_DESK','folio.item.void') && !has('FRONT_DESK','folio.reopen')],
      ['FRONT_DESK: NO reservation.override / stay.reopen', !has('FRONT_DESK','reservation.override') && !has('FRONT_DESK','stay.reopen')],
      ['FRONT_DESK: NO folio.item.adjust', !has('FRONT_DESK','folio.item.adjust')],
      ['HOUSEKEEPING: NO guest.* at all', permsOf('HOUSEKEEPING').every((k) => !k.startsWith('guest.'))],
      ['HOUSEKEEPING: NO folio.* / payment.* / invoice.*', permsOf('HOUSEKEEPING').every((k) => !/^(folio|payment|invoice)\./.test(k))],
      ['HOUSEKEEPING: NO reservation.* / stay.*', permsOf('HOUSEKEEPING').every((k) => !/^(reservation|stay)\./.test(k))],
      ['HOUSEKEEPING: NO audit-log.* / night-audit.run|approve', permsOf('HOUSEKEEPING').every((k) => !k.startsWith('audit-log.') && !['night-audit.run','night-audit.approve'].includes(k))],
      ['HOUSEKEEPING: HAS housekeeping.start + housekeeping.complete', has('HOUSEKEEPING','housekeeping.start') && has('HOUSEKEEPING','housekeeping.complete')],
      ['HOUSEKEEPING: NO housekeeping.assign / housekeeping.inspect', !has('HOUSEKEEPING','housekeeping.assign') && !has('HOUSEKEEPING','housekeeping.inspect')],
      ['AUDITOR: audit-log.read YES, audit-log.export NO', has('AUDITOR','audit-log.read') && !has('AUDITOR','audit-log.export')],
      ['AUDITOR: NO report.export', !has('AUDITOR','report.export')],
      ['AUDITOR: NO write perms (excl. self-service)', permsOf('AUDITOR').every((k) => SELF.has(k) || !WRITE_RE.test(k))],
      ['AUDITOR: NO user.* / role.* management', permsOf('AUDITOR').every((k) => !/^(user|role)\./.test(k))],
      ['ADMIN: holds all 63 catalog permissions', (db.get('ADMIN')?.size ?? 0) === 63],
    ];
    for (const [desc, ok] of checks) {
      if (!ok) fail(desc); else console.log(`PASS ${desc}`);
    }

    console.log(`\n${failures === 0 ? '=== ALL PERMISSION CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    c.release();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());