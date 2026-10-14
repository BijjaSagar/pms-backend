/**
 * Row-count census against an explicit connection.
 *
 * Used by restore-drill.ps1 to read the restored scratch database. Takes the
 * connection string as argv[2] and prints the same JSON shape as census.mjs, so
 * the drill can diff the two without special-casing either.
 *
 * Usage: node scripts/census-against.mjs <connectionString>
 */
import { Pool } from 'pg';

const TABLES = [
  'Organization', 'Property', 'User', 'Role', 'Permission', 'RolePermission',
  'PropertyMembership', 'RoomType', 'Room', 'Guest', 'Reservation',
  'ReservationRoom', 'RoomNightInventory', 'Folio', 'FolioItem', 'Payment',
  'Invoice', 'HousekeepingTask', 'MaintenanceTicket', 'NightAudit',
  'AuditLog', 'Session', 'TaxRule',
];

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('usage: node scripts/census-against.mjs <connectionString>');
  process.exit(2);
}

const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();
  const census = {};
  try {
    for (const table of TABLES) {
      try {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        census[table] = rows[0].n;
      } catch {
        census[table] = null;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(JSON.stringify(census, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });