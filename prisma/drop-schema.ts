import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main() {
  const c = await pool.connect();
  try {
    // Prisma 8 RC keeps migration state in a separate prisma_contract schema.
    // Dropping only "public" leaves the ledger intact, so `db migrate` reports
    // "Already up to date" while the real tables are gone. Both must go.
    await c.query('DROP SCHEMA IF EXISTS prisma_contract CASCADE');
    await c.query('DROP SCHEMA public CASCADE');
    await c.query('CREATE SCHEMA public');
    console.log('dropped schemas: prisma_contract, public');
    console.log('public schema recreated (empty)');
    const t = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    console.log('tables now:', t.rows[0].n);
  } finally {
    c.release();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());