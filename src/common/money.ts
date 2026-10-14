/**
 * Exact money arithmetic in integer minor units.
 *
 * Floating point is not used for any authoritative monetary value. Binary
 * floats cannot represent most decimal fractions exactly, so repeated
 * operations drift: 0.1 + 0.2 !== 0.3. For a guest folio that drift becomes a
 * balance that does not reconcile, which is the class of bug this module exists
 * to make impossible.
 *
 * Amounts are carried as integers of the currency's minor unit (paise for INR,
 * cents for USD). Values crossing the database boundary are parsed from and
 * rendered to decimal strings, never through Number.
 *
 * Rounding is half-up on the absolute value, applied once per line so that a
 * displayed total always equals the sum of displayed lines.
 */

export interface Money {
  /** Signed integer amount in minor units. */
  readonly minor: number;
}

const SCALE = 2;
const FACTOR = 10 ** SCALE;

/** Parses a decimal string into minor units. Rejects anything non-numeric. */
export function fromDecimal(value: string | number): Money {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Not a finite amount: ${value}`);
    // Route through a fixed string so the float's own imprecision is not baked in.
    return fromDecimal(value.toFixed(SCALE));
  }
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a decimal amount: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const bare = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = bare.split('.');
  const fracPadded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const minor = Number(whole) * FACTOR + Number(fracPadded);
  return { minor: negative ? -minor : minor };
}

export const zero = (): Money => ({ minor: 0 });

export function add(a: Money, b: Money): Money {
  return { minor: a.minor + b.minor };
}

export function subtract(a: Money, b: Money): Money {
  return { minor: a.minor - b.minor };
}

export function sum(items: Money[]): Money {
  return items.reduce((acc, m) => add(acc, m), zero());
}

/** Multiplies by an integer quantity. Fractional quantities are rejected. */
export function multiply(a: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new TypeError('Quantity must be a whole number of units');
  }
  return { minor: a.minor * quantity };
}

/**
 * Applies a percentage rate, rounding half-up on the absolute value.
 * A 18% GST rule is expressed as 18, not 0.18, to keep the caller explicit
 * about which side of the decimal it is supplying.
 */
export function applyPercent(a: Money, percent: number): Money {
  return { minor: roundHalfUp((a.minor * percent) / 100) };
}

function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function compare(a: Money, b: Money): number {
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

/** Renders back to a fixed 2-decimal string for storage or display. */
export function toDecimal(a: Money): string {
  const sign = a.minor < 0 ? '-' : '';
  const abs = Math.abs(a.minor);
  const whole = Math.floor(abs / FACTOR);
  const frac = String(abs % FACTOR).padStart(SCALE, '0');
  return `${sign}${whole}.${frac}`;
}

/**
 * Divides by a whole number, rounding half-up.
 *
 * Rates such as ADR and RevPAR are a money amount spread over a count of rooms.
 * Doing that as `minor / rooms` in floating point would reintroduce exactly the
 * drift this module exists to remove, so the quotient is rounded to a whole
 * minor unit here, once, at the end.
 */
export function divide(a: Money, divisor: number): Money {
  if (!Number.isInteger(divisor) || divisor === 0) {
    throw new TypeError('Divisor must be a non-zero whole number');
  }
  const sign = a.minor < 0 ? -1 : 1;
  const abs = Math.abs(a.minor);
  // floor((2n + d) / 2d) is half-up rounding without relying on Math.round's
  // behaviour for exact .5 cases.
  return { minor: sign * Math.floor((2 * abs + divisor) / (2 * divisor)) };
}

export function max(a: Money, b: Money): Money {
  return a.minor >= b.minor ? a : b;
}

export function min(a: Money, b: Money): Money {
  return a.minor <= b.minor ? a : b;
}

export interface TaxRule {
  code: string;
  /** Percentage points, e.g. 18 for 18% GST. */
  ratePercent: number;
  isInclusive: boolean;
}

/**
 * Computes line and tax totals for a set of charges.
 *
 * Tax is calculated per line and rounded once, so the tax total always equals
 * the sum of the per-line tax amounts shown to the guest. Summing unrounded
 * tax across lines and rounding at the end produces totals that visibly fail
 * to add up on the printed folio.
 *
 * Inclusive rules (price already contains the tax) are netted out of the line
 * rather than added on top.
 */
export function computeTotals(
  lines: { amount: Money; taxable: boolean }[],
  rules: TaxRule[],
): { subtotal: Money; taxTotal: Money; grandTotal: Money } {
  const applicable = rules.filter((r) => r.ratePercent > 0);
  const totalRate = applicable.reduce((acc, r) => acc + r.ratePercent, 0);
  // A mix of inclusive and exclusive rules is treated as exclusive, which is the
  // conservative reading: never net tax out of a price that excluded it.
  const allInclusive = applicable.length > 0 && applicable.every((r) => r.isInclusive);

  let subtotalMinor = 0;
  let taxMinor = 0;

  for (const line of lines) {
    const grossMinor = line.amount.minor;
    let netMinor = grossMinor;
    let lineTaxMinor = 0;

    if (line.taxable && totalRate > 0) {
      if (allInclusive) {
        // The price already contains the tax, so extract it: net = gross / (1 + rate)
        netMinor = roundHalfUp((grossMinor * 100) / (100 + totalRate));
        lineTaxMinor = grossMinor - netMinor;
      } else {
        lineTaxMinor = roundHalfUp((grossMinor * totalRate) / 100);
        netMinor = grossMinor;
      }
    }

    subtotalMinor += netMinor;
    taxMinor += lineTaxMinor;
  }

  return {
    subtotal: { minor: subtotalMinor },
    taxTotal: { minor: taxMinor },
    grandTotal: { minor: subtotalMinor + taxMinor },
  };
}