import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { computeTotals, multiply, type Money, type TaxRule } from './money.js';

/**
 * The property's active tax rules in posting shape.
 *
 * Folio posting and reservation estimates both price through here so a
 * booking-time total and the folio that follows it are computed under the
 * same rules. Callers store the result; nothing recomputes historical
 * figures from these rows later.
 */
export async function activeTaxRules(propertyId: string): Promise<TaxRule[]> {
  if (!propertyId) return [];
  const rules = await db.orm.public.TaxRule
    .where({ propertyId: brand(propertyId), isActive: brand(true) })
    .all();
  return rules.map((r) => ({
    code: r.code,
    ratePercent: Number(r.ratePercent),
    isInclusive: r.isInclusive,
  }));
}

/**
 * Gross estimate for a stay: nightly rate × nights, plus tax.
 *
 * The money module stays exact throughout; no float intermediate.
 */
export function estimateStay(nightlyRate: Money, nights: number, rules: TaxRule[]) {
  if (!Number.isInteger(nights) || nights < 0) {
    throw new TypeError('nights must be a non-negative whole number');
  }
  return computeTotals([{ amount: multiply(nightlyRate, nights), taxable: true }], rules);
}
