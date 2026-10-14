import { fromDecimal } from './money.js';

export interface LedgerLine {
  type: string;
  totalAmount: unknown;
  taxAmount?: unknown;
  isVoided: boolean;
}

/**
 * The single definition of folio charges vs tax.
 *
 * TAX-typed lines hold tax and no charge of their own; every other live line
 * holds a charge plus its own tax. Voided lines count nowhere. Balances, the
 * night audit and revenue reporting all split through here so the three can
 * never disagree about what a folio says.
 */
export function splitLedger(items: LedgerLine[]): { chargesMinor: number; taxMinor: number } {
  let chargesMinor = 0;
  let taxMinor = 0;
  for (const i of items) {
    if (i.isVoided) continue;
    if (i.type !== 'TAX') chargesMinor += minorOf(i.totalAmount);
    taxMinor += minorOf(i.taxAmount);
  }
  return { chargesMinor, taxMinor };
}

/** Stored numerics arrive as strings; anything else counts as zero. */
function minorOf(value: unknown): number {
  if (typeof value === 'string' || typeof value === 'number') return fromDecimal(value).minor;
  return 0;
}
