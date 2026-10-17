/**
 * Wire contract between the HTTP gateway and the auth microservice.
 *
 * The gateway owns the HTTP surface and the auth microservice owns session,
 * staff, role and permission state. Everything that crosses between them is
 * named here so the two processes cannot drift on a pattern string or a payload
 * shape. The values are plain data: the Redis transport JSON-serialises them, so
 * no Date, class instance or Express request is ever sent.
 */

/** Message patterns handled by the auth microservice. */
export const AUTH_MESSAGES = {
  /** Verifies credentials and opens a session. */
  LOGIN: 'auth.login',
  /** Revokes the presented session. Idempotent. */
  LOGOUT: 'auth.logout',
  /** Revokes all sessions for the user across all instances. */
  LOGOUT_ALL: 'auth.logout-all',
  /** Rotates refresh token and returns a fresh access token. */
  REFRESH: 'auth.refresh',
  /** Generates a single-use time-limited password-reset token. */
  FORGOT_PASSWORD: 'auth.forgot-password',
  /** Consumes a password-reset token and sets a new password. */
  RESET_PASSWORD: 'auth.reset-password',
  /** Resolves an access token or session token to a principal plus its effective permissions. */
  PRINCIPAL: 'auth.principal',
  /** The current user with memberships and permissions. */
  ME: 'auth.me',
  /** Switches the session's active property. */
  SWITCH_PROPERTY: 'auth.switch-property',
  /** Liveness probe used by the gateway health endpoint. */
  PING: 'auth.ping',
} as const;

/** Message patterns for staff, roles and the permission catalogue. */
export const USER_MESSAGES = {
  LIST: 'users.list',
  GET: 'users.get',
  INVITE: 'users.invite',
  REISSUE_INVITE: 'users.reissue-invite',
  CANCEL_INVITE: 'users.cancel-invite',
  ACCEPT_INVITE: 'users.accept-invite',
  UPDATE: 'users.update',
  SET_ROLE: 'users.set-role',
  SET_STATUS: 'users.set-status',
  ROLES_LIST: 'roles.list',
  ROLES_PERMISSIONS: 'roles.permissions',
  ROLES_MATRIX: 'roles.matrix',
  ROLES_SET_PERMISSIONS: 'roles.set-permissions',
} as const;

// Shared actor/transport types live in `shared.ts`; re-exported here so callers
// that already import them from this module are unaffected.
export type { RequestMeta, ActorContext, AckResult } from './shared.js';

/** The minimal principal resolved from a session or access token. */
export interface Principal {
  userId: string;
  sessionId: string;
  organizationId: string;
  activePropertyId: string | null;
}

/** Result of resolving a session or token: a principal and its effective permissions. */
export interface PrincipalResult {
  principal: Principal;
  permissions: string[];
}

/** Response to `auth.login`; `expiresAt` is an ISO string over the wire. */
export interface LoginResult {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  organizationId: string;
  activePropertyId: string | null;
}


export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface ForgotPasswordResult {
  ok: boolean;
  message: string;
  resetToken?: string;
  expiresAt?: string;
}

export interface ResetPasswordResult {
  ok: boolean;
  message: string;
}


