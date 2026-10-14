import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

const TABLES = [
  'Organization', 'Property', 'Permission', 'Role', 'RolePermission',
  'RoomType', 'Room', 'User', 'PropertyMembership', 'Session',
  'Guest', 'RatePlan', 'RatePlanPrice', 'TaxRule',
  'Reservation', 'ReservationRoom', 'RoomNightInventory',
  'Folio', 'FolioItem', 'Payment', 'Invoice',
  'HousekeepingTask', 'MaintenanceTicket', 'NightAudit',
  'AuditLog', 'Notification', 'UserThemePreference',
];

async function main() {
  const c = await pool.connect();
  const out: Record<string, number> = {};
  try {
    for (const t of TABLES) {
      const r = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
      out[t] = r.rows[0].n;
    }
    // Deep integrity: no duplicate role->permission pairs
    const dupes = await c.query(
      `SELECT count(*)::int AS n FROM (
         SELECT "roleId","permissionId" FROM "RolePermission"
         GROUP BY 1,2 HAVING count(*) > 1
       ) d`,
    );
    out['__duplicate_role_perm_pairs'] = dupes.rows[0].n;

    // Orphaned role-permissions (points at non-existent role or permission)
    const orphans = await c.query(
      `SELECT
         (SELECT count(*)::int FROM "RolePermission" rp
            LEFT JOIN "Role" r ON r.id = rp."roleId" WHERE r.id IS NULL)
       + (SELECT count(*)::int FROM "RolePermission" rp
            LEFT JOIN "Permission" p ON p.id = rp."permissionId" WHERE p.id IS NULL) AS n`,
    );
    out['__orphaned_role_perms'] = orphans.rows[0].n;

    // Orphaned rooms (room whose roomType belongs to another property)
    const crossProp = await c.query(
      `SELECT count(*)::int AS n FROM "Room" rm
       JOIN "RoomType" rt ON rt.id = rm."roomTypeId"
       WHERE rt."propertyId" <> rm."propertyId"`,
    );
    out['__rooms_with_mismatched_property'] = crossProp.rows[0].n;

    // Demo-data reconciliation: inventory must exactly cover each assigned stay.
    // Reservations in a live status with a room must hold one inventory row per
    // night; cancelled / no-show / unassigned stays hold none by design.
    const coverage = await c.query(
      `SELECT count(*)::int AS n FROM "Reservation" r
       JOIN "ReservationRoom" rr ON rr."reservationId" = r.id
       LEFT JOIN "RoomNightInventory" ni ON ni."reservationRoomId" = rr.id
       WHERE r.status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
         AND rr."roomId" IS NOT NULL
       GROUP BY r.id, r."checkInDate", r."checkOutDate"
       HAVING count(ni.id) <> (r."checkOutDate"::date - r."checkInDate"::date)`,
    );
    out['__stays_with_inventory_mismatch'] = coverage.rowCount ?? 0;

    // Assigned rooms must belong to the booked room type.
    const typeMismatch = await c.query(
      `SELECT count(*)::int AS n FROM "ReservationRoom" rr
       JOIN "Room" rm ON rm.id = rr."roomId"
       WHERE rr."roomId" IS NOT NULL AND rm."roomTypeId" <> rr."roomTypeId"`,
    );
    out['__room_lines_with_type_mismatch'] = typeMismatch.rows[0].n;

    console.log(JSON.stringify(out, null, 2));
  } finally {
    c.release();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());