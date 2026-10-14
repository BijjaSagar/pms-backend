/**
 * PII masking.
 *
 * One implementation, used by the guest list and by reports. Two separate
 * implementations would drift, and the drift would show up as a report leaking
 * an address that the guest list correctly hides.
 *
 * Masking is shape control rather than omission: the row still comes back, so
 * counts and list structure stay comparable between a caller who may see PII
 * and one who may not. What differs is only the sensitive content.
 */

const maskEmail = (v: string | null) =>
  v === null ? null : v.replace(/^(.).*(@.*)$/, (_m, a: string, b: string) => `${a}***${b}`);

const maskPhone = (v: string | null) =>
  v === null ? null : v.length <= 3 ? '***' : `${v.slice(0, 2)}***${v.slice(-2)}`;

/**
 * A partially redacted name: first initial plus surname.
 *
 * Enough to tell two Smiths apart on a shift handover, not enough to identify
 * a guest to a reader who should not have that.
 */
const maskName = (first: string | null, last: string | null) => {
  const f = first ?? '';
  const l = last ?? '';
  if (!f && !l) return null;
  return `${f ? `${f.charAt(0)}.` : ''} ${l}`.trim();
};

export { maskEmail, maskPhone, maskName };

/** Keys whose values are treated as sensitive wherever they appear. */
const SENSITIVE_KEY = /(email|phone|mobile|address|passport|aadhaar|pan|card|dob|birth)/i;

/** Values that look like secrets regardless of the key they sit under. */
const SECRET_VALUE = /(?:password|secret|token|api[_-]?key|bearer\s)/i;

const MASK = '***';

/**
 * Scrubs sensitive material out of free-form audit metadata.
 *
 * This is best-effort and deliberately conservative about claiming otherwise:
 * `metadata` holds whatever context an action supplied, which for something like
 * a maintenance description is arbitrary user free text. Key-based scrubbing
 * catches structured PII; it cannot catch a phone number typed into a sentence.
 */
export function scrubMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubMetadata);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && SECRET_VALUE.test(value) ? MASK : value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = v === null || v === undefined ? v : MASK;
    } else {
      out[k] = scrubMetadata(v);
    }
  }
  return out;
}