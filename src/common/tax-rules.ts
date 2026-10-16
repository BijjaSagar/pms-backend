import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { computeTotals, multiply, type Money, type TaxRule } from './money.js';
import type { DateOnly } from './dates.js';

export interface TaxRulesOptions {
  appliesTo?: string | string[];
  stayDate?: DateOnly;
}

export async function activeTaxRules(propertyId: string, opts?: TaxRulesOptions): Promise<TaxRule[]> {
  if (!propertyId) return [];
  const rules = await db.orm.public.TaxRule
    .where({ propertyId: brand(propertyId), isActive: brand(true) })
    .all();
  const wanted = Array.isArray(opts?.appliesTo)
    ? opts!.appliesTo
    : opts?.appliesTo
    ? [opts!.appliesTo]
    : null;
  return rules
    .filter((r) => {
      if (wanted && !wanted.includes(r.appliesTo) && r.appliesTo !== 'ALL') return false;
      if (opts?.stayDate) {
        const d = new Date(opts.stayDate);
        if (r.validFrom && d < new Date(String(r.validFrom))) return false;
        if (r.validTo && d > new Date(String(r.validTo))) return false;
      }
      return true;
    })
    .map((r) => ({
      code: r.code,
      ratePercent: Number(r.ratePercent),
      isInclusive: r.isInclusive,
    }));
}

export function estimateStay(nightlyRate: Money, nights: number, rules: TaxRule[]) {
  if (!Number.isInteger(nights) || nights < 0) {
    throw new TypeError('nights must be a non-negative whole number');
  }
  return computeTotals([{ amount: multiply(nightlyRate, nights), taxable: true }], rules);
}