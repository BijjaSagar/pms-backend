/**
 * Transaction probe. Verifies the Prisma 8 contract client exposes a usable
 * transaction context before any service code depends on it.
 *
 * Real signature (verified against the installed runtime, which differs from
 * the published .d.mts):  db.transaction(async (tx) => { ... })
 * The callback's return value becomes the transaction result. BEGIN/COMMIT/
 * ROLLBACK are handled by the runtime; the callback must NOT commit manually.
 *
 * Run: npx tsx prisma/probe-transaction.ts
 */
import 'dotenv/config';
import { db } from '../src/prisma/db.js';

async function main() {
  const anyDb = db as any;
  if (typeof anyDb.transaction !== 'function') {
    console.error('PROBE FAIL: db.transaction is not a function');
    process.exitCode = 1;
    return;
  }
  console.log('db.transaction: present');

  // --- COMMIT PATH ---
  // NOTE: standalone `.count()` is NOT supported on a collection (it exists only
  // inside include() refinements), so row totals come from findMany().length.
  const committed = await anyDb.transaction(async (tx: any) => {
    const org = await tx.orm.public.Organization.where({ slug: 'demo-hospitality' }).first();
    const perms = await tx.orm.public.Permission.where({}).findMany();
    return { orgName: org?.name ?? null, permCount: perms.length, hasSql: typeof tx.sql === 'object' };
  });
  console.log('COMMIT read ->', JSON.stringify(committed));
  if (!committed.orgName) {
    console.error('PROBE FAIL: transaction could not read seeded Organization');
    process.exitCode = 1;
    return;
  }

  // --- ROLLBACK PATH: insert then throw ---
  const marker = `probe-${Date.now()}`;
  let threw = false;
  try {
    await anyDb.transaction(async (tx: any) => {
      await tx.orm.public.Organization.create({ name: 'Probe', slug: marker });
      console.log('inserted inside tx:', marker);
      throw new Error('forced rollback');
    });
  } catch (e) {
    threw = (e as Error).message === 'forced rollback';
  }

  if (!threw) {
    console.error('PROBE FAIL: transaction did not surface the thrown error');
    process.exitCode = 1;
    return;
  }

  const ghost = await anyDb.orm.public.Organization.where({ slug: marker }).first();
  if (ghost) {
    await anyDb.orm.public.Organization.where({ slug: marker }).delete();
    console.error('PROBE FAIL: rolled-back insert persisted (rollback broken); leaked row cleaned');
    process.exitCode = 1;
    return;
  }

  console.log('ROLLBACK verified: inserted row is absent after throw');
  console.log('\nPROBE PASS: callback signature confirmed; commit + rollback both correct');
}

main().catch((e) => {
  console.error('PROBE ERROR:', e);
  process.exitCode = 1;
});