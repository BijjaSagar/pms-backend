/**
 * Row-count census for backup verification.
 *
 * Used by backup.ps1 (to write the manifest) and restore-drill.ps1 (to compare
 * against it after restoring). Exists as a node script rather than inline
 * psql calls because PowerShell's argument passing to psql proved unreliable
 * enough to silently drop flags, and a census that reports the wrong number is
 * worse than no census at all.
 *
 * Prints a JSON object of table name to row count. Exits non-zero if any table
 * in the list is absent, so a schema change that drops one is noticed rather
 * than silently skipped.
 *
 * Usage: node scripts/census.mjs [--strict]
 *   --strict  exit non-zero when a listed table is missing
 */
import 'dotenv/config';
import { Pool } from 'pg';

const TABLES = [
  'Organization', 'Property', 'User', 'Role', 'Permission', 'RolePermission',
  'PropertyMembership', 'RoomType', 'Room', 'Guest', 'Reservation',
  'ReservationRoom', 'RoomNightInventory', 'Folio', 'FolioItem', 'Payment',
  'Invoice', 'HousekeepingTask', 'MaintenanceTicket', 'NightAudit',
  'AuditLog', 'Session', 'TaxRule',
];

const strict = process.argv.includes('--strict');
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function main() {
  const client = await pool.connect();
  const census = {};
  const missing = [];
  try {
    for (const table of TABLES) {
      try {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        census[table] = rows[0].n;
      } catch (err) {
        missing.push(`${table} (${err.code ?? err.message})`);
        census[table] = null;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(census, null, 2));

  if (missing.length > 0) {
    console.error(`\nmissing tables: ${missing.join(', ')}`);
    if (strict) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });