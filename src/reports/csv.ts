/**
 * CSV rendering and the audit-log query.
 *
 * Both live together because an export is a different projection of the same
 * data the audit page shows, and the two should never disagree about what a row
 * contains.
 */

/**
 * Quotes a CSV field.
 *
 * Values beginning with `=`, `+`, `-` or `@` are prefixed with a single quote.
 * A spreadsheet treats those as formulas, so an unquoted guest-supplied value
 * would execute on open — an exported report must never be able to do that.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  // A trailing newline keeps `wc -l` and most importers happy.
  return `${lines.join('\r\n')}\r\n`;
}