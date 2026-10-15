/**
 * Types shared by every gateway ↔ microservice contract.
 *
 * Extracted so the auth and booking services describe the authenticated actor
 * and the transport conventions identically. `auth.messages.ts` re-exports
 * these, so existing imports keep working unchanged.
 */

/** Request provenance, forwarded so a service can audit it. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * The authenticated actor, detached from the HTTP request.
 *
 * The gateway builds this from the guard-populated `request.user` and sends it
 * with every command. It is the same data the in-process services read off
 * `req.user`, so audit and permission rules keep working unchanged.
 */
export interface ActorContext {
  id: string;
  organizationId: string;
  activePropertyId: string | null;
  permissions: string[];
}

/**
 * Acknowledgement for commands with no meaningful result.
 *
 * A handler that returns `undefined` produces no reply frame, which the client
 * surfaces as an RxJS `EmptyError` and a 500. Returning a concrete value keeps
 * the request/response contract intact for fire-and-forget commands.
 */
export interface AckResult {
  ok: true;
}
