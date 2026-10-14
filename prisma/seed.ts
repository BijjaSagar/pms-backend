import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
});

const permissionCatalog = [
  ['dashboard.read', 'dashboard', 'read'],
  ['user.read', 'user', 'read'], ['user.invite', 'user', 'invite'],
  ['user.update', 'user', 'update'], ['user.deactivate', 'user', 'deactivate'],
  ['role.read', 'role', 'read'], ['role.assign', 'role', 'assign'], ['role.manage', 'role', 'manage'],
  ['property.read', 'property', 'read'], ['property.update', 'property', 'update'],
  ['tax-config.update', 'tax-config', 'update'],
  ['guest.read', 'guest', 'read'], ['guest.create', 'guest', 'create'], ['guest.update', 'guest', 'update'],
  ['guest.pii.read', 'guest.pii', 'read'], ['guest.export', 'guest', 'export'],
  ['room.read', 'room', 'read'], ['room.create', 'room', 'create'], ['room.update', 'room', 'update'],
  ['room.status.update', 'room.status', 'update'], ['room.out-of-order', 'room', 'out-of-order'],
  ['reservation.read', 'reservation', 'read'], ['reservation.create', 'reservation', 'create'],
  ['reservation.update', 'reservation', 'update'], ['reservation.cancel', 'reservation', 'cancel'],
  ['reservation.assign-room', 'reservation', 'assign-room'], ['reservation.override', 'reservation', 'override'],
  ['stay.check-in', 'stay', 'check-in'], ['stay.check-out', 'stay', 'check-out'], ['stay.reopen', 'stay', 'reopen'],
  ['folio.read', 'folio', 'read'], ['folio.item.post', 'folio.item', 'post'],
  ['folio.item.adjust', 'folio.item', 'adjust'], ['folio.item.void', 'folio.item', 'void'],
  ['folio.close', 'folio', 'close'], ['folio.reopen', 'folio', 'reopen'],
  ['payment.read', 'payment', 'read'], ['payment.record', 'payment', 'record'],
  ['payment.refund', 'payment', 'refund'], ['payment.reconcile', 'payment', 'reconcile'],
  ['invoice.read', 'invoice', 'read'], ['invoice.issue', 'invoice', 'issue'],
  ['invoice.void', 'invoice', 'void'], ['invoice.export', 'invoice', 'export'],
  ['housekeeping.read', 'housekeeping', 'read'], ['housekeeping.assign', 'housekeeping', 'assign'],
  ['housekeeping.start', 'housekeeping', 'start'], ['housekeeping.complete', 'housekeeping', 'complete'],
  ['housekeeping.inspect', 'housekeeping', 'inspect'],
  ['maintenance.read', 'maintenance', 'read'], ['maintenance.create', 'maintenance', 'create'],
  ['maintenance.assign', 'maintenance', 'assign'], ['maintenance.resolve', 'maintenance', 'resolve'],
  ['report.read.operations', 'report', 'read.operations'], ['report.read.financial', 'report', 'read.financial'],
  ['report.export', 'report', 'export'],
  ['night-audit.read', 'night-audit', 'read'], ['night-audit.run', 'night-audit', 'run'],
  ['night-audit.approve', 'night-audit', 'approve'],
  ['audit-log.read', 'audit-log', 'read'], ['audit-log.export', 'audit-log', 'export'],
  ['theme.update', 'theme', 'update'], ['profile.update', 'profile', 'update'],
] as const;

type RoleKey = 'ADMIN' | 'MANAGER' | 'FRONT_DESK' | 'HOUSEKEEPING' | 'AUDITOR';

const fullOperational = [
  'dashboard.read', 'guest.read', 'guest.create', 'guest.update', 'guest.pii.read',
  'room.read', 'room.create', 'room.update', 'room.status.update', 'room.out-of-order',
  'reservation.read', 'reservation.create', 'reservation.update', 'reservation.cancel',
  'reservation.assign-room', 'reservation.override', 'stay.check-in', 'stay.check-out', 'stay.reopen',
  'folio.read', 'folio.item.post', 'folio.item.adjust', 'folio.item.void', 'folio.close', 'folio.reopen',
  'payment.read', 'payment.record', 'payment.refund', 'payment.reconcile',
  'invoice.read', 'invoice.issue', 'invoice.void', 'invoice.export',
  'housekeeping.read', 'housekeeping.assign', 'housekeeping.start', 'housekeeping.complete', 'housekeeping.inspect',
  'maintenance.read', 'maintenance.create', 'maintenance.assign', 'maintenance.resolve',
  'report.read.operations', 'report.read.financial', 'report.export',
  'night-audit.read', 'night-audit.run', 'night-audit.approve', 'audit-log.read', 'audit-log.export',
  'theme.update', 'profile.update', 'property.read', 'property.update', 'tax-config.update',
  'user.read', 'user.invite', 'user.update', 'user.deactivate', 'role.read', 'role.assign', 'role.manage',
  'guest.export',
];

const rolePermissions: Record<RoleKey, string[]> = {
  ADMIN: [...new Set(fullOperational)],
  MANAGER: [
    'dashboard.read', 'guest.read', 'guest.create', 'guest.update', 'guest.pii.read',
    'room.read', 'room.create', 'room.update', 'room.status.update', 'room.out-of-order',
    'reservation.read', 'reservation.create', 'reservation.update', 'reservation.cancel',
    'reservation.assign-room', 'reservation.override', 'stay.check-in', 'stay.check-out',
    'folio.read', 'folio.item.post', 'folio.item.adjust', 'payment.read', 'payment.record',
    'invoice.read', 'invoice.issue', 'housekeeping.read', 'housekeeping.assign', 'housekeeping.start',
    'housekeeping.complete', 'housekeeping.inspect', 'maintenance.read', 'maintenance.create',
    'maintenance.assign', 'maintenance.resolve', 'report.read.operations', 'report.read.financial',
    'report.export', 'night-audit.read', 'night-audit.run', 'night-audit.approve',
    'audit-log.read', 'theme.update', 'profile.update', 'property.read', 'user.read',
  ],
  FRONT_DESK: [
    'dashboard.read', 'guest.read', 'guest.create', 'guest.update', 'guest.pii.read',
    'room.read', 'room.status.update', 'reservation.read', 'reservation.create', 'reservation.update',
    'reservation.cancel', 'reservation.assign-room', 'stay.check-in', 'stay.check-out',
    'folio.read', 'folio.item.post', 'payment.read', 'payment.record', 'invoice.read', 'invoice.issue',
    'housekeeping.read', 'maintenance.read', 'maintenance.create', 'report.read.operations',
    'night-audit.read', 'theme.update', 'profile.update', 'property.read',
  ],
  HOUSEKEEPING: [
    'dashboard.read', 'room.read', 'room.status.update', 'housekeeping.read', 'housekeeping.start',
    'housekeeping.complete', 'maintenance.read', 'maintenance.create', 'profile.update', 'theme.update',
  ],
  AUDITOR: [
    'dashboard.read', 'guest.read', 'room.read', 'reservation.read', 'folio.read', 'payment.read',
    'invoice.read', 'housekeeping.read', 'maintenance.read', 'report.read.operations',
    'report.read.financial', 'night-audit.read', 'audit-log.read', 'profile.update', 'theme.update',
  ],
};

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert organization
    let orgResult = await client.query(
      `INSERT INTO "Organization" (id, name, slug, status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), 'Demo Hospitality Group', 'demo-hospitality', 'ACTIVE', NOW(), NOW())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    const organizationId = orgResult.rows[0].id;

    // Upsert property
    let propResult = await client.query(
      `INSERT INTO "Property" (id, "organizationId", name, slug, timezone, "currencyCode", "countryCode", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'Main Hotel', 'main-hotel', 'Asia/Kolkata', 'INR', 'IN', NOW(), NOW())
       ON CONFLICT ("organizationId", slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [organizationId],
    );
    const propertyId = propResult.rows[0].id;

    // Seed permissions
    for (const [key, resource, action] of permissionCatalog) {
      await client.query(
        `INSERT INTO "Permission" (id, key, resource, action, description, "createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
         ON CONFLICT (key) DO UPDATE SET resource = EXCLUDED.resource, action = EXCLUDED.action`,
        [key, resource, action, `${resource}: ${action}`],
      );
    }

    // Seed roles with permission mappings
    const roleMeta: Array<{ key: RoleKey; name: string; description: string }> = [
      { key: 'ADMIN', name: 'Admin', description: 'Property/organization administration and privileged operations.' },
      { key: 'MANAGER', name: 'Manager', description: 'Daily operations, approvals and reporting.' },
      { key: 'FRONT_DESK', name: 'Front Desk / Receptionist', description: 'Reservations, guest arrival/departure and permitted billing.' },
      { key: 'HOUSEKEEPING', name: 'Housekeeping', description: 'Assigned cleaning tasks and room-readiness workflow.' },
      { key: 'AUDITOR', name: 'Auditor', description: 'Read-only audit and reporting role.' },
    ];

    for (const roleDef of roleMeta) {
      let roleResult = await client.query(
        `INSERT INTO "Role" (id, "organizationId", key, name, description, "isSystem", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true, true, NOW(), NOW())
         ON CONFLICT ("organizationId", key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, "isSystem" = true, "isActive" = true
         RETURNING id`,
        [organizationId, roleDef.key, roleDef.name, roleDef.description],
      );
      const roleId = roleResult.rows[0].id;

      // Delete existing role-permission mappings
      await client.query(`DELETE FROM "RolePermission" WHERE "roleId" = $1`, [roleId]);

      // Create new role-permission mappings
      const keys = rolePermissions[roleDef.key];
      for (const key of keys) {
        await client.query(
          `INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
           SELECT $1, p.id, NOW()
           FROM "Permission" p
           WHERE p.key = $2
           ON CONFLICT DO NOTHING`,
          [roleId, key],
        );
      }
    }

    // Seed sample room types
    const roomTypes = [
      { code: 'STD', name: 'Standard', maxAdults: 2, baseRate: 2500 },
      { code: 'DLX', name: 'Deluxe', maxAdults: 2, baseRate: 4000 },
      { code: 'FAM', name: 'Family', maxAdults: 4, baseRate: 5500 },
      { code: 'SUT', name: 'Suite', maxAdults: 3, baseRate: 8000 },
      { code: 'PEN', name: 'Penthouse', maxAdults: 4, baseRate: 15000 },
    ];

    for (const rt of roomTypes) {
      await client.query(
        `INSERT INTO "RoomType" (id, "propertyId", code, name, description, "maxAdults", "maxChildren", "baseOccupancy", "baseRate", "isActive", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), $1, $2::varchar, $3, $4, $5, 1, $6, $7, true, NOW(), NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM "RoomType" WHERE "propertyId" = $1 AND code = $2::varchar
         )`,
        [propertyId, rt.code, rt.name, `${rt.name} room`, rt.maxAdults, rt.maxAdults, rt.baseRate],
      );
    }

    // Seed sample rooms (5 floors, 4 rooms each)
    const roomTypeResult = await client.query(
      `SELECT id, code FROM "RoomType" WHERE "propertyId" = $1`,
      [propertyId],
    );
    const roomTypeRecords = roomTypeResult.rows;

    for (let floor = 1; floor <= 5; floor++) {
      for (let room = 1; room <= 4; room++) {
        const roomNumber = `${floor}0${room}`;
        const roomType = roomTypeRecords[(floor + room - 2) % roomTypeRecords.length];
        await client.query(
          `INSERT INTO "Room" (id, "propertyId", "roomTypeId", "roomNumber", floor, wing, status, "isActive", "createdAt", "updatedAt")
           SELECT gen_random_uuid(), $1, $2, $3::varchar, $4, $5::varchar, 'VACANT_CLEAN', true, NOW(), NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM "Room" WHERE "propertyId" = $1 AND "roomNumber" = $3::varchar
           )`,
          [propertyId, roomType.id, roomNumber, `Floor ${floor}`, room <= 2 ? 'East' : 'West'],
        );
      }
    }
    // Backfill wings for databases seeded before wings existed.
    await client.query(
      `UPDATE "Room" SET wing =
         CASE WHEN right("roomNumber", 1) IN ('1', '2') THEN 'East' ELSE 'West' END
       WHERE "propertyId" = $1 AND wing IS NULL`,
      [propertyId],
    );

    // A tax rule so folio totals are non-zero from the first booking. Without
    // it the checkout balance rule cannot distinguish a paid stay from an
    // unpaid one. Upserted here (and in dev-users) so either order works.
    await client.query(
      `INSERT INTO "TaxRule" (id, "propertyId", code, name, "ratePercent", "appliesTo", "isInclusive", "isCompound", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'GST18', 'GST 18%', 18, 'ALL', false, false, true, NOW(), NOW())
       ON CONFLICT ("propertyId", code) DO UPDATE SET "ratePercent" = EXCLUDED."ratePercent", "isActive" = true, "updatedAt" = NOW()`,
      [propertyId],
    );

    // Rate plans + nightly prices for the next ~60 nights (plus a 15-night
    // lookback so recent stays price too). The booking flow still snapshots
    // the room-type base rate; these rows drive the Rates UI and reports.
    const ratePlans = [
      { code: 'BAR', name: 'Best Available Rate', rate: 3500, refundable: true, minStay: 1, policy: 'Free cancellation until 24h before arrival.' },
      { code: 'CORP', name: 'Corporate', rate: 3000, refundable: true, minStay: 1, policy: 'Corporate direct billing. Free cancellation until check-in.' },
      { code: 'ADV', name: 'Advance Purchase', rate: 2800, refundable: false, minStay: 2, policy: 'Prepaid, non-refundable. 14-day advance purchase.' },
    ];
    const planIds: Record<string, string> = {};
    for (const p of ratePlans) {
      const existing = await client.query(
        `SELECT id FROM "RatePlan" WHERE "propertyId" = $1 AND code = $2`,
        [propertyId, p.code],
      );
      if (existing.rows.length > 0) {
        planIds[p.code] = existing.rows[0].id;
        continue;
      }
      const ins = await client.query(
        `INSERT INTO "RatePlan" (id, "propertyId", code, name, "currencyCode", "defaultNightlyRate", "cancellationPolicy", "minStayNights", "isRefundable", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'INR', $4, $5, $6, $7, true, NOW(), NOW())
         RETURNING id`,
        [propertyId, p.code, p.name, p.rate, p.policy, p.minStay, p.refundable],
      );
      planIds[p.code] = ins.rows[0].id;
    }
    // Prices: weekend uplift of +500, deterministic from the calendar.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const base = new Date(`${todayUtc}T00:00:00Z`);
    for (let offset = -15; offset <= 60; offset++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + offset);
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      const weekend = dow === 0 || dow === 6;
      for (const p of ratePlans) {
        const nightly = p.rate + (weekend ? 500 : 0);
        await client.query(
          `INSERT INTO "RatePlanPrice" (id, "ratePlanId", "stayDate", "nightlyRate", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2::date, $3, NOW(), NOW())
           ON CONFLICT ("ratePlanId", "stayDate") DO UPDATE SET "nightlyRate" = EXCLUDED."nightlyRate", "updatedAt" = NOW()`,
          [planIds[p.code], iso, nightly],
        );
      }
    }

    await client.query('COMMIT');
    console.info('Seeded organization, property, permissions, 5 roles, room types, rooms (with wings), GST18 tax rule, 3 rate plans + prices.');
    console.info('No login credentials were created. Run npm run db:dev-users for role logins, npm run db:seed:demo for transactional demo data.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
