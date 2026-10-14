/**
 * Hotel date helpers.
 *
 * Stay dates are date-only values, never instants. A night is a calendar day at
 * the property, not a moment in time, so every function here works on
 * `YYYY-MM-DD` strings and does its arithmetic in UTC. Parsing with
 * `new Date('2026-11-01')` would parse as UTC midnight but `getDate()` would
 * then read it back in local time, shifting the day for anyone west of
 * Greenwich. That bug is invisible in India and corrupts reports elsewhere.
 */

export type DateOnly = string; // YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: unknown): value is DateOnly {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Converts a Date to a UTC calendar date string. */
export function toDateOnly(d: Date): DateOnly {
  return d.toISOString().slice(0, 10);
}

/** Parses a date-only string to a UTC midnight instant. */
export function parseDateOnly(value: DateOnly): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Adds whole days to a date-only string without any timezone drift. */
export function addDays(value: DateOnly, days: number): DateOnly {
  const d = parseDateOnly(value);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateOnly(d);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function diffDays(from: DateOnly, to: DateOnly): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / 86_400_000);
}

/**
 * The nights a stay consumes.
 *
 * Check-in is inclusive and check-out is exclusive, so 10th to 12th consumes
 * the nights of the 10th and 11th only. The 12th is free for the next guest.
 */
export function enumerateNights(checkIn: DateOnly, checkOut: DateOnly): DateOnly[] {
  const nights: DateOnly[] = [];
  const total = diffDays(checkIn, checkOut);
  for (let i = 0; i < total; i++) nights.push(addDays(checkIn, i));
  return nights;
}

export function nightCount(checkIn: DateOnly, checkOut: DateOnly): number {
  return Math.max(0, diffDays(checkIn, checkOut));
}

export class InvalidStayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStayError';
  }
}

/**
 * Validates a stay range. Checkout must be strictly after check-in; a
 * same-day checkout is rejected rather than silently treated as zero nights,
 * because it almost always means the caller swapped the two values.
 */
export function validateStay(checkIn: DateOnly, checkOut: DateOnly): void {
  if (!isDateOnly(checkIn)) throw new InvalidStayError('check-in must be a valid YYYY-MM-DD date');
  if (!isDateOnly(checkOut)) throw new InvalidStayError('check-out must be a valid YYYY-MM-DD date');
  if (diffDays(checkIn, checkOut) <= 0) {
    throw new InvalidStayError('check-out must be at least one night after check-in');
  }
}

/**
 * The property's current business date.
 *
 * Deliberately derived from UTC plus the property's fixed offset rather than
 * the server clock, so "today" means the same thing for every property and does
 * not depend on where the API happens to be running.
 */
export function businessDateFor(timezone: string, now: Date = new Date()): DateOnly {
  try {
    // en-CA renders as YYYY-MM-DD, which is exactly the shape we want.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An unknown zone falls back to UTC rather than throwing mid-request.
    return toDateOnly(now);
  }
}

/**
 * Parses a timestamp from the ORM.
 *
 * The driver returns two shapes: ISO with a `Z` offset (`2026-10-13T18:30:00.000Z`)
 * and a space-separated form with no offset (`2026-10-13 23:23:24.418`). The
 * second form is UTC, and `new Date()` will read it as *local* time in some
 * environments, which silently shifts a timestamp across a day boundary.
 *
 * Anything that compares a stored timestamp against a business date has to go
 * through here, otherwise "today's folios" quietly becomes "yesterday's" for
 * any property whose timezone is ahead of the server's.
 */
export function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const s = String(value ?? '').trim();
  if (!s) return new Date(NaN);
  const normalised = /^\d{4}-\d{2}-\d{2} /.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  return new Date(normalised);
}

/** The property's business date for a stored timestamp. */
export function businessDateOf(timezone: string, value: unknown): DateOnly {
  return businessDateFor(timezone, parseTimestamp(value));
}