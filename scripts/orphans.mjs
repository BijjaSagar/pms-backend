/**
 * Referential-integrity check for a restored database.
 *
 * The row census in census.mjs proves the same *number* of rows came back. It
 * cannot prove they still point at each other: a restore that duplicated a
 * table, or restored children without their parents, matches every count and
 * is still unusable. This checks the foreign keys that actually matter.
 *
 * Exits 0 when there are no orphans, 1 otherwise, printing the counts either
 * way so a failure says which relationship broke.
 *
 * Usage: node scripts/orphans.mjs <connectionString>
 */
import { Pool } from 'pg';

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('usage: node scripts/orphans.mjs <connectionString>');
  process.exit(2);
}

// Table names are quoted throughout. Unquoted identifiers are folded to lower
// case by PostgreSQL, and every model here is CamelCase, so an unquoted name
// resolves to a table that does not exist.
const CHECKS = [
  ['folio items without a folio', '"FolioItem" fi', '"Folio" f ON f.id = fi."folioId"', 'f.id'],
  ['payments without a folio', '"Payment" pa', '"Folio" f ON f.id = pa."folioId"', 'f.id'],
  ['invoices without a folio', '"Invoice" i', '"Folio" f ON f.id = i."folioId"', 'f.id'],
  ['room-nights without a room', '"RoomNightInventory" n', '"Room" r ON r.id = n."roomId"', 'r.id'],
  ['room-nights without a reservation room',
    '"RoomNightInventory" n', '"ReservationRoom" rr ON rr.id = n."reservationRoomId"', 'rr.id'],
  ['reservations without a primary guest',
    '"Reservation" res', '"Guest" g ON g.id = res."primaryGuestId"', 'g.id'],
  ['memberships without a user',
    '"PropertyMembership" m', '"User" u ON u.id = m."userId"', 'u.id'],
  ['memberships without a role',
    '"PropertyMembership" m', '"Role" r ON r.id = m."roleId"', 'r.id'],
  ['roles without an organisation',
    '"Role" r', '"Organization" o ON o.id = r."organizationId"', 'o.id'],
  ['rooms without a room type',
    '"Room" rm', '"RoomType" rt ON rt.id = rm."roomTypeId"', 'rt.id'],
];

const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();
  let total = 0;
  const report = [];
  try {
    for (const [label, from, join, parentColumn] of CHECKS) {
      const sql = `SELECT count(*)::int AS n FROM ${from} LEFT JOIN ${join} WHERE ${parentColumn} IS NULL`;
      const { rows } = await client.query(sql);
      total += rows[0].n;
      report.push(`  ${rows[0].n === 0 ? 'ok  ' : 'ORPH'} ${label}: ${rows[0].n}`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(report.join('\n'));
  if (total > 0) {
    console.error(`\n${total} orphaned row(s)`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });