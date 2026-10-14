/**
 * Boundary helpers for the Prisma 8 contract client.
 *
 * The client brands its write types so that a value only satisfies a column if
 * its declared length and timestamp precision match the schema exactly:
 * `Varchar<320>` is `string & { __varcharLength: 320 }`, and `TimestampString<3>`
 * is a branded string rather than a Date.
 *
 * Those brands exist only in the type system and are erased at runtime, and the
 * database enforces length and precision on its own. `brand()` is the single
 * place where a plain JavaScript value is narrowed to its branded slot, so the
 * rest of the codebase does not need casts scattered through every mutation.
 *
 * Reads need no equivalent: a branded string is still assignable to `string`.
 */
export const brand = (value: unknown): never => value as never;

/** Current time as the branded timestamp the client expects for timestamp(3). */
export const now = (): never => new Date().toISOString() as never;

/** Formats a Date (or passes a string through) as a branded timestamp. */
export const ts = (value: Date | string): never =>
  (typeof value === 'string' ? value : value.toISOString()) as never;

/** Narrows a plain JSON value for jsonb columns. */
export const json = (value: unknown): never => value as never;