import { describe, expect, it } from 'vitest';
import {
  add,
  applyPercent,
  compare,
  computeTotals,
  fromDecimal,
  isNegative,
  multiply,
  subtract,
  sum,
  toDecimal,
  zero,
} from './money.js';

describe('money', () => {
  it('parses and renders without float drift', () => {
    expect(toDecimal(fromDecimal('0.1'))).toBe('0.10');
    expect(toDecimal(add(fromDecimal('0.1'), fromDecimal('0.2')))).toBe('0.30');
    expect(toDecimal(fromDecimal('1234.56'))).toBe('1234.56');
    expect(toDecimal(fromDecimal('-42.5'))).toBe('-42.50');
    expect(toDecimal(fromDecimal('7'))).toBe('7.00');
  });

  it('rejects values that are not decimal amounts', () => {
    expect(() => fromDecimal('abc')).toThrow(TypeError);
    expect(() => fromDecimal('')).toThrow(TypeError);
    expect(() => fromDecimal('1.2.3')).toThrow(TypeError);
    expect(() => fromDecimal(Number.NaN)).toThrow(TypeError);
  });

  it('multiplies whole units exactly', () => {
    expect(toDecimal(multiply(fromDecimal('1234.56'), 3))).toBe('3703.68');
    expect(toDecimal(multiply(fromDecimal('0.01'), 7))).toBe('0.07');
    // 19.99 * 3 is a classic float failure case.
    expect(toDecimal(multiply(fromDecimal('19.99'), 3))).toBe('59.97');
  });

  it('refuses fractional quantities', () => {
    expect(() => multiply(fromDecimal('10'), 1.5)).toThrow(TypeError);
  });

  it('sums many values without accumulating error', () => {
    const cents = Array.from({ length: 1000 }, () => fromDecimal('0.01'));
    expect(toDecimal(sum(cents))).toBe('10.00');
  });

  it('computes 18% tax with half-up rounding', () => {
    // 1000 + 18% = 1180 exactly
    expect(toDecimal(applyPercent(fromDecimal('1000'), 18))).toBe('180.00');
    // 99.99 * 18% = 17.9982 -> 18.00
    expect(toDecimal(applyPercent(fromDecimal('99.99'), 18))).toBe('18.00');
    // Round-half-up: 0.05 * 18% = 0.009 -> 0.01
    expect(toDecimal(applyPercent(fromDecimal('0.05'), 18))).toBe('0.01');
  });

  it('rounds half-up on negatives symmetrically', () => {
    expect(toDecimal(applyPercent(fromDecimal('-99.99'), 18))).toBe('-18.00');
  });

  it('signs and compares correctly', () => {
    expect(isNegative(fromDecimal('-0.01'))).toBe(true);
    expect(compare(fromDecimal('10'), fromDecimal('10'))).toBe(0);
    expect(compare(fromDecimal('9.99'), fromDecimal('10'))).toBe(-1);
    expect(compare(subtract(fromDecimal('10'), fromDecimal('9.99')), fromDecimal('0.01'))).toBe(0);
    expect(isNegative(subtract(fromDecimal('1'), fromDecimal('2')))).toBe(true);
  });

  describe('computeTotals', () => {
    const gst = [{ code: 'GST', ratePercent: 18, isInclusive: false }];

    it('adds exclusive tax on top', () => {
      const r = computeTotals([{ amount: fromDecimal('1000'), taxable: true }], gst);
      expect(toDecimal(r.subtotal)).toBe('1000.00');
      expect(toDecimal(r.taxTotal)).toBe('180.00');
      expect(toDecimal(r.grandTotal)).toBe('1180.00');
    });

    it('nets inclusive tax out of the line', () => {
      const r = computeTotals(
        [{ amount: fromDecimal('1180'), taxable: true }],
        [{ code: 'GST', ratePercent: 18, isInclusive: true }],
      );
      expect(toDecimal(r.subtotal)).toBe('1000.00');
      expect(toDecimal(r.taxTotal)).toBe('180.00');
      expect(toDecimal(r.grandTotal)).toBe('1180.00');
    });

    it('rounds tax per line so the displayed lines always add up', () => {
      // Three room nights at 333.33 with 18%: each line taxes to 60.00
      const r = computeTotals(
        [
          { amount: fromDecimal('333.33'), taxable: true },
          { amount: fromDecimal('333.33'), taxable: true },
          { amount: fromDecimal('333.33'), taxable: true },
        ],
        gst,
      );
      expect(toDecimal(r.subtotal)).toBe('999.99');
      expect(toDecimal(r.taxTotal)).toBe('180.00');
      expect(toDecimal(r.grandTotal)).toBe('1179.99');
      // The invariant that matters on a printed folio.
      expect(
        r.subtotal.minor + r.taxTotal.minor,
      ).toBe(r.grandTotal.minor);
    });

    it('leaves non-taxable lines untaxed', () => {
      const r = computeTotals(
        [
          { amount: fromDecimal('1000'), taxable: true },
          { amount: fromDecimal('500'), taxable: false },
        ],
        gst,
      );
      expect(toDecimal(r.subtotal)).toBe('1500.00');
      expect(toDecimal(r.taxTotal)).toBe('180.00');
    });

    it('handles no tax rules at all', () => {
      const r = computeTotals([{ amount: fromDecimal('2500'), taxable: true }], []);
      expect(toDecimal(r.grandTotal)).toBe('2500.00');
      expect(r.taxTotal.minor).toBe(0);
    });

    it('handles an empty folio', () => {
      const r = computeTotals([], gst);
      expect(r.subtotal.minor).toBe(0);
      expect(r.grandTotal.minor).toBe(0);
      expect(toDecimal(zero())).toBe('0.00');
    });

    it('produces a negative total for a credit line', () => {
      const r = computeTotals([{ amount: fromDecimal('-100'), taxable: false }], gst);
      expect(toDecimal(r.grandTotal)).toBe('-100.00');
    });
  });
});