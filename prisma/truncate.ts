/**
 * Truncates every table in the public schema while keeping the schema itself.
 *
 * Unlike `drop-schema.ts` (which drops `public` + `prisma_contract` and forces
 * a full `db migrate`), this keeps the migration ledger intact so the next
 * `db:seed` runs against the existing schema. Table list is discovered from
 * `information_schema`, so future models are covered without editing this file.
 *
 * Run: npm run db:truncate
 * Full reseed: npm run db:reseed
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main() {
  const c = await pool.connect();
  try {
    const tablesRes = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables: string[] = tablesRes.rows.map((r) => r.table_name as string);
    if (tables.length === 0) {
      console.log('no tables in public schema; nothing to truncate');
      return;
    }

    const before: Record<string, number> = {};
    for (const t of tables) {
      const r = await c.query(`SELECT count(*)::int AS n FROM "public"."${t}"`);
      before[t] = r.rows[0].n as number;
    }
    const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
    console.log(`truncating ${tables.length} table(s), ${totalBefore} row(s) total`);
    for (const [t, n] of Object.entries(before)) {
      if (n > 0) console.log(`  ${t}: ${n}`);
    }

    const quoted = tables.map((t) => `"public"."${t}"`).join(', ');
    await c.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

    let totalAfter = 0;
    for (const t of tables) {
      const r = await c.query(`SELECT count(*)::int AS n FROM "public"."${t}"`);
      totalAfter += r.rows[0].n as number;
    }
    console.log(`done. rows now: ${totalAfter}`);
  } finally {
    c.release();
  }
}

main()
  .catch((e) => {
    console.error('truncate failed:', e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
