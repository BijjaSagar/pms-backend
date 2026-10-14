import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateFor,
  diffDays,
  enumerateNights,
  InvalidStayError,
  isDateOnly,
  nightCount,
  validateStay,
} from './dates.js';

describe('date helpers', () => {
  it('treats checkout as exclusive', () => {
    expect(enumerateNights('2026-11-01', '2026-11-03')).toEqual(['2026-11-01', '2026-11-02']);
    expect(nightCount('2026-11-01', '2026-11-03')).toBe(2);
  });

  it('handles a month boundary', () => {
    expect(enumerateNights('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('handles a leap day', () => {
    expect(enumerateNights('2028-02-27', '2028-03-01')).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
    ]);
  });

  it('does not drift across a DST change in a western timezone', () => {
    // US DST starts 2026-03-08. Local-time arithmetic would lose a day here.
    expect(nightCount('2026-03-07', '2026-03-09')).toBe(2);
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
  });

  it('rejects a stay that ends on or before it starts', () => {
    expect(() => validateStay('2026-11-01', '2026-11-01')).toThrow(InvalidStayError);
    expect(() => validateStay('2026-11-03', '2026-11-01')).toThrow(InvalidStayError);
    expect(() => validateStay('2026-11-01', '2026-11-02')).not.toThrow();
  });

  it('rejects malformed dates', () => {
    expect(isDateOnly('2026-13-01')).toBe(false);
    expect(isDateOnly('01-11-2026')).toBe(false);
    expect(isDateOnly('not-a-date')).toBe(false);
    expect(() => validateStay('01/11/2026', '2026-11-02')).toThrow(InvalidStayError);
  });

  it('computes negative diffs when the end precedes the start', () => {
    expect(diffDays('2026-11-03', '2026-11-01')).toBe(-2);
  });

  it('derives the business date from the property timezone, not the server', () => {
    // 23:30 UTC on the 1st is already the 2nd in Kolkata (+05:30).
    const instant = new Date('2026-11-01T23:30:00Z');
    expect(businessDateFor('Asia/Kolkata', instant)).toBe('2026-11-02');
    // ...but still the 1st in New York (-05:00).
    expect(businessDateFor('America/New_York', instant)).toBe('2026-11-01');
    expect(businessDateFor('UTC', instant)).toBe('2026-11-01');
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(businessDateFor('Not/AZone', new Date('2026-11-01T23:30:00Z'))).toBe('2026-11-01');
  });
});