/**
 * Phase 6A acceptance checks.
 *
 * The kit's gate is: duplicate requests cannot post charge or payment twice,
 * money uses decimal-safe logic, and unauthorized staff cannot void, refund or
 * reopen. Each is fired as real HTTP rather than asserted from the database,
 * because the guarantee is about the API's behaviour, not the table contents.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { cleanup, pinProperty, pool as cleanupPool } from './cleanup-test-data.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'DevPass!2026';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? '  -> ' + d : ''}`);
  ok ? pass++ : fail++;
};

async function call(path: string, init: RequestInit = {}, cookie = '') {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function login(email: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const q = (sql: string, params?: unknown[]) => pool.query(sql, params as never[]);

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

async function main() {
  await cleanup();

  const admin = await login('admin@dev.local');
  await pinProperty(admin);
  const manager = await login('manager@dev.local');
  const fd = await login('frontdesk@dev.local');
  const auditor = await login('auditor@dev.local');

  const types = await call('/room-types', {}, admin);
  const rt = types.body.find((t: any) => t.isActive);

  const g = await call('/guests', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Phase6', lastName: 'p6-guest' }),
  }, admin);
  const guestId = g.body.id;

  const arrivals0 = await call('/front-desk/arrivals', {}, fd);
  if (arrivals0.status !== 200 || !/^\d{4}-\d{2}-\d{2}$/.test(arrivals0.body?.businessDate ?? '')) {
    console.error(
      `Could not read the property business date (status=${arrivals0.status}). ` +
      'This suite logs in five times, so back-to-back runs hit the login throttle; wait 60s.',
    );
    console.error(JSON.stringify(arrivals0.body).slice(0, 300));
    process.exitCode = 1;
    return;
  }
  const today = arrivals0.body.businessDate;
  const avail = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, {}, admin);
  const room = avail.body.available[0];

  const book = (roomId: string) =>
    call('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        primaryGuestId: guestId, checkInDate: today, checkOutDate: addDays(today, 2),
        adults: 1, children: 0, roomTypeId: rt.id, roomId,
      }),
    }, admin);

  const res1 = await book(room.id);
  const ci = await call(`/reservations/${res1.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  const folioId = ci.body.folioId;
  check('fixture stay is checked in with an open folio', !!folioId, folioId);

  // Check-in posts the first night, so the folio is not empty. Every figure
  // below is asserted as a delta against this baseline rather than an absolute,
  // otherwise the room charge silently invalidates the arithmetic.
  const base = await call(`/folios/${folioId}/balance`, {}, admin);
  const baseCharges = parseFloat(base.body.charges);
  const baseTax = parseFloat(base.body.tax);
  check('check-in posted the first night', baseCharges > 0, `${base.body.charges} + ${base.body.tax} tax`);

  // ---------------------------------------------------------------- idempotency
  const key = `p6-charge-${Date.now()}`;
  const c1 = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Minibar', quantity: '1',
      unitAmount: '500.00', idempotencyKey: key,
    }),
  }, fd);
  check('front desk can post a charge', c1.status === 201 || c1.status === 200, `status=${c1.status}`);

  const c2 = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Minibar', quantity: '1',
      unitAmount: '500.00', idempotencyKey: key,
    }),
  }, fd);
  check('a replayed charge returns the original line', c2.body?.id === c1.body?.id, `${c1.body?.id} vs ${c2.body?.id}`);

  const itemCount = await q(
    `SELECT count(*)::int AS n FROM "FolioItem" WHERE "folioId" = $1 AND description = 'Minibar'`,
    [folioId]);
  check('a replayed charge did not post twice', itemCount.rows[0].n === 1, `${itemCount.rows[0].n} rows`);

  // ------------------------------------------------------- decimal-safe money
  // 10.10 * 3 is 30.300000000000004 in binary floating point. The folio must
  // report exactly 30.30.
  await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Laundry', quantity: '3',
      unitAmount: '10.10', idempotencyKey: `${key}-laundry`,
    }),
  }, fd);
  const bal = await call(`/folios/${folioId}/balance`, {}, admin);
  const laundry = 30.3;                 // 10.10 x 3 — inexact as a float
  const minibarTax = 90;                // 500.00 at 18%
  const laundryTax = 5.45;              // 30.30 at 18% = 5.454, rounds to 5.45
  check(
    'a float-unsafe multiplication is reported exactly',
    Math.abs(parseFloat(bal.body.charges) - (baseCharges + 500 + laundry)) < 0.001,
    `charges=${bal.body.charges} expected=${(baseCharges + 500 + laundry).toFixed(2)}`,
  );
  check(
    'tax on each line is exact to the paisa',
    Math.abs(parseFloat(bal.body.tax) - (baseTax + minibarTax + laundryTax)) < 0.001,
    `tax=${bal.body.tax} expected=${(baseTax + minibarTax + laundryTax).toFixed(2)}`,
  );
  check(
    'total equals charges plus tax',
    Math.abs(parseFloat(bal.body.charges) + parseFloat(bal.body.tax) - parseFloat(bal.body.total)) < 0.001,
    `${bal.body.charges} + ${bal.body.tax} = ${bal.body.total}`,
  );

  // ---------------------------------------------------------- tax is a snapshot
  const activeRules = await q(
    `SELECT count(*)::int AS n FROM "TaxRule" WHERE "isActive" = true`);
  check(
    'exactly one tax rule is active, so the expected tax figures are well defined',
    activeRules.rows[0].n === 1,
    `${activeRules.rows[0].n} active rules`,
  );

  const beforeEdit = await call(`/folios/${folioId}/balance`, {}, admin);
  await q(`UPDATE "TaxRule" SET "ratePercent" = 5 WHERE code = 'GST18'`);
  const afterEdit = await call(`/folios/${folioId}/balance`, {}, admin);
  check(
    'editing the tax rule does not rewrite an existing folio',
    JSON.stringify(afterEdit.body) === JSON.stringify(beforeEdit.body),
    `${beforeEdit.body.total} -> ${afterEdit.body.total}`,
  );

  // The new rate still applies to postings made after the edit. That is what
  // makes the folio a snapshot of its own charges rather than a frozen thing.
  const late = await call(`/folios/${folioId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'INCIDENTAL', description: 'Late checkout', quantity: '1',
      unitAmount: '100.00', idempotencyKey: `${key}-late`,
    }),
  }, fd);
  const withLate = await call(`/folios/${folioId}/balance`, {}, admin);
  const lateTax = parseFloat(withLate.body.tax) - parseFloat(afterEdit.body.tax);
  check(
    'a charge posted after the edit uses the new rate',
    Math.abs(lateTax - 5) < 0.001,
    `tax on 100.00 = ${lateTax.toFixed(2)} at 5%`,
  );
  check('the charge posted under the new rate was accepted', late.status === 201 || late.status === 200);

  await q(`UPDATE "TaxRule" SET "ratePercent" = 18 WHERE code = 'GST18'`);

  const restored = await call(`/folios/${folioId}/balance`, {}, admin);
  check(
    'restoring the rate leaves the folio exactly as it was',
    restored.body.total === withLate.body.total,
    `${withLate.body.total} -> ${restored.body.total}`,
  );

  // --------------------------------------------------------------------- void
  const noReason = await call(`/folio-items/${c1.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: '  ' }),
  }, admin);
  check('voiding without a reason is rejected (400)', noReason.status === 400, `status=${noReason.status}`);

  const fdVoid = await call(`/folio-items/${c1.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'not my charge' }),
  }, fd);
  check('front desk cannot void a charge (403)', fdVoid.status === 403, `status=${fdVoid.status}`);

  const voided = await call(`/folio-items/${c1.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'charged to wrong room' }),
  }, admin);
  check('admin can void with a reason', voided.status === 201 || voided.status === 200, `status=${voided.status}`);

  const voidRows = await q(
    `SELECT count(*)::int AS n FROM "FolioItem" WHERE "folioId" = $1 AND "isVoided" = true`, [folioId]);
  check('the void wrote a paired reversal, both flagged', voidRows.rows[0].n === 2, `${voidRows.rows[0].n} flagged rows`);

  const balAfterVoid = await call(`/folios/${folioId}/balance`, {}, admin);
  check(
    'a voided charge leaves the money untouched (the pair nets to zero)',
    Math.abs(parseFloat(balAfterVoid.body.charges) - (baseCharges + 100 + laundry)) < 0.001,
    `charges=${balAfterVoid.body.charges} expected=${(baseCharges + 100 + laundry).toFixed(2)}`,
  );

  const voidAgain = await call(`/folio-items/${c1.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'again' }),
  }, admin);
  check('repeating a void is idempotent', voidAgain.body?.idempotent === true);

  const voidRows2 = await q(
    `SELECT count(*)::int AS n FROM "FolioItem" WHERE "folioId" = $1 AND "isVoided" = true`, [folioId]);
  check('a repeated void wrote no second reversal', voidRows2.rows[0].n === 2, `${voidRows2.rows[0].n} flagged rows`);

  // ------------------------------------------------------------------ payment
  const total = balAfterVoid.body.total;
  const payKey = `p6-pay-${Date.now()}`;
  const p1 = await call(`/folios/${folioId}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount: total, method: 'CASH', idempotencyKey: payKey }),
  }, fd);
  check('front desk can record a payment', p1.status === 201 || p1.status === 200, `status=${p1.status}`);
  const p2 = await call(`/folios/${folioId}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount: total, method: 'CASH', idempotencyKey: payKey }),
  }, fd);
  check('a replayed payment returns the original row', p2.body?.id === p1.body?.id);

  const payCount = await q(
    `SELECT count(*)::int AS n FROM "Payment" WHERE "folioId" = $1`, [folioId]);
  check('a replayed payment did not take the money twice', payCount.rows[0].n === 1, `${payCount.rows[0].n} payments`);

  const settled = await call(`/folios/${folioId}/balance`, {}, admin);
  check('balance is zero after settling', Math.abs(parseFloat(settled.body.balance)) < 0.001, settled.body.balance);

  // ------------------------------------------------------------------- refund
  const half = (parseFloat(total) / 2).toFixed(2);
  const fdRefund = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: half, reason: 'cash given' }),
  }, fd);
  check('front desk cannot refund (403)', fdRefund.status === 403, `status=${fdRefund.status}`);

  const auditorRefund = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: half, reason: 'cash given' }),
  }, auditor);
  check('an auditor cannot refund (403)', auditorRefund.status === 403, `status=${auditorRefund.status}`);

  const noReasonRefund = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: half, reason: '' }),
  }, admin);
  check('refunding without a reason is rejected (400)', noReasonRefund.status === 400, `status=${noReasonRefund.status}`);

  // One rupee beyond what was collected. Refunding exactly `total` would be a
// legitimate full refund, not an over-refund, so the probe has to exceed it.
  const tooMuch = (parseFloat(total) + 1).toFixed(2);
  const overRef = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: tooMuch, reason: 'greedy' }),
  }, admin);
  check('refunding more than was paid is rejected (409)', overRef.status === 409, `status=${overRef.status}`);
  check('the refusal states the refundable amount', /refundable/i.test(JSON.stringify(overRef.body)));

  const r1 = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: half, reason: 'partial settlement' }),
  }, admin);
  check('admin can refund part of a payment', r1.status === 201 || r1.status === 200, `status=${r1.status}`);
  check('a partial refund reports PARTIALLY_REFUNDED', r1.body?.status === 'PARTIALLY_REFUNDED', r1.body?.status);

  const balPartial = await call(`/folios/${folioId}/balance`, {}, admin);
  check(
    'a partial refund restores exactly that much to the folio',
    Math.abs(parseFloat(balPartial.body.balance) - parseFloat(half)) < 0.011,
    `balance=${balPartial.body.balance} expected=${half}`,
  );
  check(
    'a partially refunded payment is still counted as collected in part',
    Math.abs(parseFloat(balPartial.body.paid) - (parseFloat(total) - parseFloat(half))) < 0.011,
    `paid=${balPartial.body.paid}`,
  );

  // The remainder is taken from what the server reports as still refundable
  // rather than assumed. Splitting a total into two rounded halves does not
  // always sum back to the original: 4860.75 halves to 2430.38, which is one
  // paisa more than half of it.
  const remainder = r1.body?.refundableRemaining;
  const r2 = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: remainder, reason: 'rest of it' }),
  }, admin);
  check('refunding the exact remainder is accepted', r2.status === 201 || r2.status === 200, `status=${r2.status} remainder=${remainder}`);
  check('refunding the remainder reports REFUNDED', r2.body?.status === 'REFUNDED', r2.body?.status);
  check('nothing is left refundable', Number(r2.body?.refundableRemaining) === 0, String(r2.body?.refundableRemaining));

  const r3 = await call(`/payments/${p1.body.id}/refund`, {
    method: 'POST', body: JSON.stringify({ amount: '1.00', reason: 'again' }),
  }, admin);
  check('a fully refunded payment cannot be refunded again (409)', r3.status === 409, `status=${r3.status}`);

  // ------------------------------------------------------- close, reopen, audit
  const fdClose = await call(`/folios/${folioId}/close`, { method: 'POST', body: '{}' }, fd);
  check('front desk cannot close a folio (403)', fdClose.status === 403, `status=${fdClose.status}`);

  const closed = await call(`/folios/${folioId}/close`, { method: 'POST', body: '{}' }, admin);
  check('admin can close a folio', closed.status === 201 || closed.status === 200, `status=${closed.status}`);

  const closeAgain = await call(`/folios/${folioId}/close`, { method: 'POST', body: '{}' }, admin);
  check('closing twice is idempotent', closeAgain.body?.idempotent === true);

  const fdReopen = await call(`/folios/${folioId}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'fix' }),
  }, fd);
  check('front desk cannot reopen a folio (403)', fdReopen.status === 403, `status=${fdReopen.status}`);

  const mgrReopen = await call(`/folios/${folioId}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'fix' }),
  }, manager);
  check('a manager cannot reopen either (403)', mgrReopen.status === 403, `status=${mgrReopen.status}`);

  const reopened = await call(`/folios/${folioId}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'guest disputed laundry' }),
  }, admin);
  check('admin can reopen with a reason', reopened.status === 201 || reopened.status === 200, `status=${reopened.status}`);

  const audited = await q(
    `SELECT count(*)::int AS n FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'folio.reopen'`,
    [folioId]);
  check('the reopen was audited', audited.rows[0].n === 1, `${audited.rows[0].n} rows`);

  const reasonLogged = await q(
    `SELECT reason FROM "AuditLog" WHERE "resourceId" = $1 AND action = 'folio.reopen'`, [folioId]);
  check('the audit row carries the reason', /disputed/.test(reasonLogged.rows[0]?.reason ?? ''), reasonLogged.rows[0]?.reason);

  // ------------------------------------------------------------------ invoice
  // Availability is re-read rather than reused: the first stay now holds the
  // room that was second in the original list, so the stale list has nothing
  // available at that position.
  const avail2 = await call(
    `/availability?checkIn=${today}&checkOut=${addDays(today, 2)}&roomTypeId=${rt.id}`, {}, admin);
  const res2 = await book(avail2.body.available[0].id);
  check('second stay was created', res2.status === 201, `status=${res2.status}`);
  await call(`/reservations/${res2.body.id}/check-in`, { method: 'POST', body: '{}' }, fd);
  const folio2 = (await q(`SELECT id FROM "Folio" WHERE "reservationId" = $1`, [res2.body.id])).rows[0].id;

  const early = await call(`/folios/${folio2}/invoices`, { method: 'POST', body: '{}' }, fd);
  check('invoicing an open folio is refused (409)', early.status === 409, `status=${early.status}`);

  const pay2 = await call(`/folios/${folio2}/balance`, {}, admin);
  await call(`/folios/${folio2}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount: pay2.body.total, method: 'CASH', idempotencyKey: `p6-pay2-${Date.now()}` }),
  }, fd);
  await call(`/folios/${folio2}/close`, { method: 'POST', body: '{}' }, admin);

  const fdInvoice = await call(`/folios/${folio2}/invoices`, { method: 'POST', body: '{}' }, fd);
  check('front desk can issue an invoice', fdInvoice.status === 201 || fdInvoice.status === 200, `status=${fdInvoice.status}`);
  check('the invoice number is allocated', /^INV-/.test(fdInvoice.body?.invoiceNo ?? ''), fdInvoice.body?.invoiceNo);

  const dupInvoice = await call(`/folios/${folio2}/invoices`, { method: 'POST', body: '{}' }, fd);
  check('a second invoice on the same folio is idempotent', dupInvoice.body?.idempotent === true);

  const invCount = await q(`SELECT count(*)::int AS n FROM "Invoice" WHERE "folioId" = $1`, [folio2]);
  check('only one invoice exists', invCount.rows[0].n === 1, `${invCount.rows[0].n}`);

  // Reopen must be blocked while an issued invoice stands.
  const blockedReopen = await call(`/folios/${folio2}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'want to change it' }),
  }, admin);
  check('reopening behind an issued invoice is refused (409)', blockedReopen.status === 409, `status=${blockedReopen.status}`);
  check('the refusal names the invoice', /INV-/.test(JSON.stringify(blockedReopen.body)));

  const fdVoidInv = await call(`/invoices/${fdInvoice.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'wrong' }),
  }, fd);
  check('front desk cannot void an invoice (403)', fdVoidInv.status === 403, `status=${fdVoidInv.status}`);

  const voidInv = await call(`/invoices/${fdInvoice.body.id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'raised against the wrong folio' }),
  }, admin);
  check('admin can void an invoice with a reason', voidInv.status === 201 || voidInv.status === 200, `status=${voidInv.status}`);

  const nowOk = await call(`/folios/${folio2}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason: 'after voiding the invoice' }),
  }, admin);
  check('reopen succeeds once the invoice is voided', nowOk.status === 201 || nowOk.status === 200, `status=${nowOk.status}`);

  // ------------------------------------------------------------------- detail
  const detail = await call(`/folios/${folioId}`, {}, admin);
  check('folio detail responds 200', detail.status === 200, `status=${detail.status}`);
  check('detail carries items, payments and invoices',
    Array.isArray(detail.body?.items) && Array.isArray(detail.body?.payments) && Array.isArray(detail.body?.invoices));
  check('detail carries the balance', detail.body?.balance?.total !== undefined, detail.body?.balance?.total);
  const voidedShown = detail.body.items.filter((i: any) => i.isVoided).length;
  check('voided lines stay visible in the ledger', voidedShown === 2, `${voidedShown} shown`);

  const ledger = await call('/payments', {}, admin);
  check('payment ledger responds 200', ledger.status === 200, `status=${ledger.status}`);
  check('the ledger joins folio numbers',
    Array.isArray(ledger.body) && ledger.body.every((p: any) => p.folioNo !== undefined));
  check('the ledger reports refunds', ledger.body.some((p: any) => p.refundedAmount !== '0.00'));

  const invList = await call('/invoices', {}, admin);
  check('invoice list responds 200', invList.status === 200, `status=${invList.status}`);
  check('the invoice list shows the void state',
    invList.body.some((i: any) => i.status === 'VOID'));

  const fdLedger = await call('/payments', {}, fd);
  check('front desk can read the payment ledger', fdLedger.status === 200, `status=${fdLedger.status}`);

  const hk = await login('housekeeping@dev.local');
  const hkLedger = await call('/payments', {}, hk);
  check('housekeeping cannot read the payment ledger (403)', hkLedger.status === 403, `status=${hkLedger.status}`);
  const hkFolio = await call(`/folios/${folioId}`, {}, hk);
  check('housekeeping cannot read a folio (403)', hkFolio.status === 403, `status=${hkFolio.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await cleanupPool.end(); });