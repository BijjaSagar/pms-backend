import { describe, expect, it } from 'vitest';
import { estimateStay } from './tax-rules.js';
import { splitLedger } from './ledger.js';
import { fromDecimal, toDecimal } from './money.js';

const GST18 = [{ code: 'GST18', ratePercent: 18, isInclusive: false }];
const GST18_INCL = [{ code: 'GST18', ratePercent: 18, isInclusive: true }];

describe('estimateStay', () => {
  it('prices a stay gross under exclusive tax', () => {
    // 2500 x 3 nights = 7500 + 18% (1350) = 8850
    const r = estimateStay(fromDecimal('2500'), 3, GST18);
    expect(toDecimal(r.subtotal)).toBe('7500.00');
    expect(toDecimal(r.taxTotal)).toBe('1350.00');
    expect(toDecimal(r.grandTotal)).toBe('8850.00');
  });

  it('nets inclusive tax out of the rate', () => {
    const r = estimateStay(fromDecimal('1180'), 1, GST18_INCL);
    expect(toDecimal(r.subtotal)).toBe('1000.00');
    expect(toDecimal(r.taxTotal)).toBe('180.00');
    expect(toDecimal(r.grandTotal)).toBe('1180.00');
  });

  it('leaves tax at zero when no rules apply', () => {
    const r = estimateStay(fromDecimal('4000'), 2, []);
    expect(toDecimal(r.subtotal)).toBe('8000.00');
    expect(toDecimal(r.taxTotal)).toBe('0.00');
    expect(toDecimal(r.grandTotal)).toBe('8000.00');
  });

  it('rejects bad night counts', () => {
    expect(() => estimateStay(fromDecimal('100'), -1, GST18)).toThrow(TypeError);
    expect(() => estimateStay(fromDecimal('100'), 1.5, GST18)).toThrow(TypeError);
  });
});

describe('splitLedger', () => {
  it('splits charges and tax with one definition', () => {
    const { chargesMinor, taxMinor } = splitLedger([
      { type: 'ROOM_CHARGE', totalAmount: '2500.00', taxAmount: '450.00', isVoided: false },
      { type: 'INCIDENTAL', totalAmount: '500.00', taxAmount: '90.00', isVoided: false },
      // TAX lines hold tax only; voided lines count nowhere.
      { type: 'TAX', totalAmount: '0.00', taxAmount: '0.00', isVoided: false },
      { type: 'ROOM_CHARGE', totalAmount: '2500.00', taxAmount: '450.00', isVoided: true },
      { type: 'DISCOUNT', totalAmount: '-200.00', taxAmount: '0.00', isVoided: false },
    ]);
    expect(chargesMinor).toBe(250000 + 50000 - 20000);
    expect(taxMinor).toBe(45000 + 9000);
  });
});
