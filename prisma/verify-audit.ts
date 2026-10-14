/** Confirms auth events were written to the append-only AuditLog. */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main() {
  const c = await pool.connect();
  try {
    const rows = await c.query(
      `SELECT action, outcome, reason, "resourceType",
              ("ipAddress" IS NOT NULL) AS has_ip,
              ("userAgent" IS NOT NULL) AS has_ua,
              ("requestId" IS NOT NULL) AS has_reqid
       FROM "AuditLog" ORDER BY "createdAt" ASC`,
    );
    console.log('total audit rows:', rows.rowCount);
    const byAction: Record<string, number> = {};
    for (const r of rows.rows) {
      const k = `${r.action}/${r.outcome}${r.reason ? ` (${r.reason})` : ''}`;
      byAction[k] = (byAction[k] ?? 0) + 1;
    }
    console.log('\nbreakdown:');
    for (const [k, v] of Object.entries(byAction).sort()) console.log(`  ${k.padEnd(42)} ${v}`);

    // Append-only: the model intentionally has no updatedAt column.
    const updatable = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='AuditLog' AND column_name='updatedAt'`,
    );
    console.log('\nAuditLog has updatedAt column (must be false):', (updatable.rowCount ?? 0) > 0);

    // Nothing sensitive may have landed in the evidence stream. Match the
    // argon2 hash signature and long opaque tokens, not the word "password",
    // which legitimately appears inside diagnostic labels like "bad_password".
    const leak = await c.query(
      `SELECT count(*)::int AS n FROM "AuditLog"
       WHERE metadata::text ~* '\\$argon2'
          OR reason ~* '\\$argon2'
          OR metadata::text ~ '[A-Za-z0-9_-]{40,}'
          OR reason ~ '[A-Za-z0-9_-]{40,}'`,
    );
    console.log('rows containing hash/token material (must be 0):', leak.rows[0].n);
  } finally {
    c.release();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());