/**
 * Clears test artefacts so verification suites are repeatable.
 *
 * Each suite tags the guests it creates (`p4a-`, `p5a-`) and passes that prefix
 * here. Rooms are reset rather than deleted, because they are seeded inventory
 * rather than test data.
 *
 * Without this, a suite's own leftovers outlive it: reservations stay CONFIRMED
 * and keep holding nights, so the next run finds no availability and fails for a
 * reason that has nothing to do with the code under test.
 */
import 'dotenv/config';
import { Pool } from 'pg';

export const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

/**
 * Every suite tags the guests it creates. All of them are cleared, not just the
 * caller's own: a checked-in stay from one phase keeps holding its nights after
 * that phase's run finishes, so a later suite that books tonight's inventory
 * finds nothing free and fails for a reason unrelated to the code. Clearing
 * across prefixes is what makes the suites runnable in any order.
 */
const ALL_TEST_PREFIXES = [
  'p3-', 'p4a-', 'p5a-', 'p6-', 'p7-', 'p8-', 'p9-', 'p10-', 'p-contract',
];

export async function cleanup(prefix?: string | string[]) {
  const prefixes = prefix
    ? (Array.isArray(prefix) ? prefix : [prefix])
    : ALL_TEST_PREFIXES;
  // A tagged guest that matches nothing here would leak its stay and hold its
  // nights forever, starving whichever suite runs next.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const prop = await c.query(`SELECT id FROM "Property" WHERE slug = 'main-hotel'`);
    if (prop.rows.length === 0) {
      await c.query('COMMIT');
      console.log('no main-hotel property; nothing to clean');
      return;
    }
    const pid = prop.rows[0].id;

    // A guest may own several reservations, so every stay is removed before the
    // guest row itself; otherwise the foreign key still holds references.
    const guests = await c.query(
      `SELECT id FROM "Guest" WHERE ${prefixes.map((_, i) => `"lastName" LIKE $${i + 1}`).join(' OR ')}`,
      prefixes.map((p) => `${p}%`),
    );
    const guestIds = guests.rows.map((g) => g.id);

    if (guestIds.length > 0) {
      const stays = await c.query(
        `SELECT id FROM "Reservation" WHERE "primaryGuestId" = ANY($1::uuid[])`,
        [guestIds],
      );
      for (const row of stays.rows) {
        // Invoices reference the folio and must go first, or the folio delete
        // fails on a foreign key and leaves the suite unable to clean up after
        // itself.
        await c.query(
          `DELETE FROM "Invoice" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" = $1)`,
          [row.id],
        );
        await c.query(
          `DELETE FROM "FolioItem" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" = $1)`,
          [row.id],
        );
        await c.query(
          `DELETE FROM "Payment" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" = $1)`,
          [row.id],
        );
        await c.query(`DELETE FROM "Folio" WHERE "reservationId" = $1`, [row.id]);
        await c.query(
          `DELETE FROM "RoomNightInventory" WHERE "reservationRoomId" IN
             (SELECT id FROM "ReservationRoom" WHERE "reservationId" = $1)`,
          [row.id],
        );
        await c.query(`DELETE FROM "ReservationRoom" WHERE "reservationId" = $1`, [row.id]);
        await c.query(`DELETE FROM "Reservation" WHERE id = $1`, [row.id]);
      }
      await c.query(`DELETE FROM "Guest" WHERE id = ANY($1::uuid[])`, [guestIds]);
    }

    await c.query(`UPDATE "Room" SET status = 'VACANT_CLEAN' WHERE "propertyId" = $1`, [pid]);
    // Tasks and tickets are removed in every state, not just TODO. A task left
    // in BLOCKED or IN_PROGRESS would otherwise survive the next run and make
    // task creation refuse with a conflict that has nothing to do with the code
    // under test. The seed creates none, so nothing real is lost.
    await c.query(`DELETE FROM "HousekeepingTask" WHERE "propertyId" = $1`, [pid]);
    await c.query(`DELETE FROM "MaintenanceTicket" WHERE "propertyId" = $1`, [pid]);

    // Test-created tax rules go too. Tax rules are additive — every active rule
    // contributes to the rate — so a stray 5% fixture left behind by another
    // suite silently changes what every later suite's tax assertions expect.
    await c.query(`DELETE FROM "TaxRule" WHERE code LIKE 'P9%' OR code = 'SERVICE5'`);

    // Staff created by the staff-administration suite. These do not hold rooms,
    // so they never starve another suite — but a run that failed part way
    // through would leave invited and disabled accounts in the staff list, and
    // the next run of that suite would trip over its own leftovers.
    const testStaff = await c.query(
      `SELECT id FROM "User" WHERE email LIKE 'p9-%'`);
    for (const row of testStaff.rows) {
      await c.query(`DELETE FROM "Session" WHERE "userId" = $1`, [row.id]);
      await c.query(`DELETE FROM "PropertyMembership" WHERE "userId" = $1`, [row.id]);
      await c.query(`DELETE FROM "AuditLog" WHERE "actorUserId" = $1`, [row.id]);
      await c.query(`DELETE FROM "User" WHERE id = $1`, [row.id]);
    }

    await c.query('COMMIT');
    console.log(
      `cleaned ${guestIds.length} test guest(s) (${prefixes.join(', ')}) and their stays; rooms reset to VACANT_CLEAN`,
    );
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Points a session at the property the suites use.
 *
 * `switch-property` applies to the current session only, and a fresh login
 * creates a new one on the user's default property. The dev admin belongs to
 * two properties and only one carries inventory, so a suite that does not pin
 * this after login queries an empty property and concludes there are no rooms.
 *
 * Returns the property id, or null when it could not be determined.
 */
export async function pinProperty(
  cookie: string,
  apiBase = 'http://localhost:3000/api/v1',
): Promise<string | null> {
  const res = await fetch(`${apiBase}/properties`, { headers: { cookie } });
  if (!res.ok) return null;
  const list = (await res.json()) as { id: string; slug: string }[];
  const target = list.find((p) => p.slug === 'main-hotel') ?? list[0];
  if (!target) return null;

  const switched = await fetch(`${apiBase}/auth/switch-property`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ propertyId: target.id }),
  });
  return switched.ok ? target.id : null;
}

// Only runs when invoked directly. The verification suites import `cleanup`
// instead, so that a run is repeatable without a separate preparatory step.
if (process.argv[1]?.endsWith('cleanup-test-data.ts')) {
  cleanup()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}