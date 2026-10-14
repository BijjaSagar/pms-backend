import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main() {
  const c = await pool.connect();
  try {
    // Table count
    const tables = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    console.log('tables:', tables.rows[0].n);

    // Enum count
    const enums = await c.query(
      `SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace
       WHERE t.typtype='e' AND ns.nspname='public'`,
    );
    console.log('enums:', enums.rows[0].n);

    // Index / constraint counts
    const idx = await c.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`,
    );
    console.log('indexes:', idx.rows[0].n);

    const fks = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints
       WHERE table_schema='public' AND constraint_type='FOREIGN KEY'`,
    );
    console.log('foreign_keys:', fks.rows[0].n);

    // Kit invariant: AuditLog must have NO updatedAt (append-only)
    const auditCols = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='AuditLog' ORDER BY column_name`,
    );
    const names: string[] = auditCols.rows.map((r) => r.column_name);
    console.log('AuditLog has updatedAt:', names.includes('updatedAt'), '(kit requires false)');

    // Kit invariant: RoomNightInventory unique on (roomId, stayDate) = double-booking backstop
    const rni = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='RoomNightInventory'`,
    );
    console.log('RoomNightInventory unique indexes:');
    rni.rows.forEach((r) => console.log('  ', r.indexdef));

    // Kit invariant: money columns must be numeric, never float
    const money = await c.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema='public'
         AND data_type IN ('double precision','real','money','character varying')
         AND (column_name LIKE '%Amount%' OR column_name LIKE '%Rate%' OR column_name LIKE '%Subtotal%' OR column_name LIKE '%Tax%')
       ORDER BY table_name, column_name`,
    );
    console.log('money-ish columns with non-numeric type (expect 0):', money.rows.length);
    money.rows.forEach((r) => console.log('  !!', r.table_name, r.column_name, r.data_type));

    // Spot-check a numeric money column
    const nm = await c.query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='FolioItem' AND column_name='totalAmount'`,
    );
    console.log('FolioItem.totalAmount:', JSON.stringify(nm.rows[0]));
  } finally {
    c.release();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());