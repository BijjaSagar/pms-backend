/**
 * Development-only fixtures.
 *
 * Creates one ACTIVE user per built-in role with known passwords, plus a second
 * property. The second property is not decorative: without it the
 * cross-property isolation requirement cannot be tested, because a user with a
 * single membership can never be asked to reach a property they do not belong to.
 *
 * NOT part of the main seed. Never run against a shared environment.
 * Run: npm run db:dev-users
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

const PASSWORD = 'DevPass!2026';
const ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'AUDITOR'] as const;
const USERS: Record<(typeof ROLES)[number], string> = {
  ADMIN: 'admin@dev.local',
  MANAGER: 'manager@dev.local',
  FRONT_DESK: 'frontdesk@dev.local',
  HOUSEKEEPING: 'housekeeping@dev.local',
  AUDITOR: 'auditor@dev.local',
};

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const hash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const orgRes = await client.query(`SELECT id FROM "Organization" WHERE slug = 'demo-hospitality'`);
    if (orgRes.rowCount === 0) throw new Error('Run the main seed first: npm run db:seed');
    const organizationId = orgRes.rows[0].id;

    const mainRes = await client.query(
      `SELECT id FROM "Property" WHERE "organizationId" = $1 AND slug = 'main-hotel'`,
      [organizationId],
    );
    const mainPropertyId = mainRes.rows[0].id;

    // Second property, used purely to prove membership scoping.
    const secondRes = await client.query(
      `INSERT INTO "Property" (id, "organizationId", name, slug, timezone, "currencyCode", "countryCode", "checkInTime", "checkOutTime", "taxInclusivePricing", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'Annex Property', 'annex-property', 'Asia/Kolkata', 'INR', 'IN', '14:00', '11:00', false, true, NOW(), NOW())
       ON CONFLICT ("organizationId", slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [organizationId],
    );
    const secondPropertyId = secondRes.rows[0].id;

    // A tax rule so folio totals are not always zero. Without it the checkout
    // balance rule cannot distinguish a paid stay from an unpaid one, and the
    // payment path would never be exercised.
    await client.query(
      `INSERT INTO "TaxRule" (id, "propertyId", code, name, "ratePercent", "appliesTo", "isInclusive", "isCompound", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'GST18', 'GST 18%', 18, 'ALL', false, false, true, NOW(), NOW())
       ON CONFLICT ("propertyId", code) DO UPDATE SET "ratePercent" = EXCLUDED."ratePercent", "isActive" = true`,
      [mainPropertyId],
    );

    const roleRows = await client.query(
      `SELECT id, key FROM "Role" WHERE "organizationId" = $1`,
      [organizationId],
    );
    const roleByKey = new Map(roleRows.rows.map((r) => [r.key, r.id]));

    for (const role of ROLES) {
      const roleId = roleByKey.get(role);
      if (!roleId) throw new Error(`Missing role ${role}; run npm run db:seed`);
      const email = USERS[role];

      const userRes = await client.query(
        `INSERT INTO "User" (id, email, "fullName", "passwordHash", status, "emailVerifiedAt", "passwordChangedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', NOW(), NOW(), NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash", status = 'ACTIVE', "updatedAt" = NOW()
         RETURNING id`,
        [email, `${role.replace('_', ' ')} Dev`, hash],
      );
      const userId = userRes.rows[0].id;

      // Admin and Manager get access to both properties; the operational roles
      // only see the main one, so the cross-property denial path is reachable.
      const properties = role === 'ADMIN' ? [mainPropertyId, secondPropertyId] : [mainPropertyId];
      for (const propertyId of properties) {
        await client.query(
          `INSERT INTO "PropertyMembership" (id, "userId", "propertyId", "roleId", "isActive", "invitedAt", "acceptedAt", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, true, NOW(), NOW(), NOW(), NOW())
           ON CONFLICT ("userId", "propertyId") DO UPDATE SET "roleId" = EXCLUDED."roleId", "isActive" = true, "updatedAt" = NOW()`,
          [userId, propertyId, roleId],
        );
      }
    }

    await client.query('COMMIT');
    console.info('Dev users ready. Shared password:', PASSWORD);
    for (const role of ROLES) console.info(`  ${role.padEnd(12)} ${USERS[role]}`);
    console.info('Second property "annex-property" available for isolation testing (Admin only).');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => { console.error('dev-users failed:', e); process.exitCode = 1; })
  .finally(() => pool.end());