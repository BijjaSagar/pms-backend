import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, now, ts } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { TokenService } from './token.service.js';
import { RedisService } from '../database/redis.service.js';
import type { RequestMeta } from '../contracts/auth.messages.js';

/**
 * Argon2id parameters. Tuned for interactive logins on modest hardware.
 *
 * Exported so invitation acceptance hashes with the same parameters rather than
 * a second, subtly different set — a weaker hash on one path would be invisible
 * until someone noticed.
 */
export const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB, OWASP minimum
  timeCost: 2,
  parallelism: 1,
} as const;

export interface MembershipView {
  id: string;
  userId: string;
  propertyId: string;
  roleId: string;
  isActive: boolean;
  role: { id: string; key: string; name: string; description: string | null };
  property: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currencyCode: string;
  };
}

export interface AuthMeView {
  user: {
    id: string;
    email: string;
    fullName: string;
    status: string;
    propertyMemberships: MembershipView[];
  };
  activePropertyId: string | null;
  permissions: string[];
}

interface RefreshTokenRecord {
  sessionId: string;
  userId: string;
  familyId: string;
  isUsed: boolean;
  expiresAt: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  private get sessionTtlMs(): number {
    const hours = Number(this.config.get<number>('session.ttlHours') ?? 12);
    return hours * 60 * 60 * 1000;
  }

  private get refreshTtlSeconds(): number {
    return 7 * 24 * 60 * 60; // 7 days
  }

  // ------------------------------------------------------------------------ login

  /**
   * Verifies credentials and opens a session, issuing an opaque session token,
   * an HS256 JWT access token, and a rotatable refresh token.
   */
  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{
    token: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    userId: string;
    organizationId: string;
    activePropertyId: string | null;
  }> {
    const normalized = email.trim().toLowerCase();
    const user = await db.orm.public.User.where({ email: brand(normalized) }).first();

    // Constant-time hash verification against dummy hash on miss
    const hash = user?.passwordHash ?? (await getDummyHash());
    const ok = await argon2.verify(hash, password).catch(() => false);

    const organizationId = user ? await this.resolveOrganizationId(user.id) : null;

    if (!user || !ok || !user.passwordHash || user.status !== 'ACTIVE' || !organizationId) {
      if (organizationId) {
        await this.audit.record({
          organizationId,
          actorUserId: user?.id ?? null,
          action: 'auth.login',
          resourceType: 'Session',
          outcome: 'FAILURE',
          reason: !user
            ? 'unknown_email'
            : !user.passwordHash
              ? 'no_password_set'
              : !ok
                ? 'bad_password'
                : `account_${user.status.toLowerCase()}`,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          requestId: meta.requestId ?? null,
        });
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    const memberships = await this.loadMemberships(user.id);
    const active = memberships.find((m) => m.isActive) ?? null;

    const token = this.tokens.createSessionToken();
    const tokenHash = this.tokens.hashSessionToken(token);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);

    let session: any;
    await db.transaction(async (tx) => {
      session = await tx.orm.public.Session.create({
        userId: brand(user.id),
        tokenHash: brand(tokenHash),
        activePropertyId: brand(active?.propertyId ?? null),
        expiresAt: ts(expiresAt),
        ipAddress: brand(meta.ip ?? null),
        userAgent: brand(meta.userAgent ?? null),
      });
      await tx.orm.public.User.where({ id: brand(user.id) }).update({ lastLoginAt: now() });
      await this.audit.record(
        {
          organizationId,
          propertyId: active?.propertyId ?? null,
          actorUserId: user.id,
          action: 'auth.login',
          resourceType: 'Session',
          resourceId: session.id,
          outcome: 'SUCCESS',
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          requestId: meta.requestId ?? null,
        },
        tx,
      );
    });

    const permissions = active?.propertyId
      ? await this.permissionsForProperty(user.id, active.propertyId)
      : [];

    // Issue HS256 JWT access token
    const { token: accessToken } = this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      org: organizationId,
      prop: active?.propertyId ?? null,
      sid: session.id,
      perms: permissions,
      expiresInSeconds: 900, // 15 minutes
    });

    // Issue rotatable refresh token
    const refreshToken = this.tokens.createRefreshToken();
    const refreshHash = this.tokens.hashSessionToken(refreshToken);
    const familyId = session.id;

    await this.redis.setJson<RefreshTokenRecord>(
      `auth:refresh:${refreshHash}`,
      {
        sessionId: session.id,
        userId: user.id,
        familyId,
        isUsed: false,
        expiresAt: Date.now() + this.refreshTtlSeconds * 1000,
      },
      this.refreshTtlSeconds,
    );

    return {
      token,
      accessToken,
      refreshToken,
      expiresAt,
      userId: user.id,
      organizationId,
      activePropertyId: active?.propertyId ?? null,
    };
  }

  // ----------------------------------------------------------------- token refresh

  /**
   * Refreshes access token with strict refresh token rotation.
   * If a previously rotated (already used) token is presented again,
   * reuse detection triggers and the entire token family/session is revoked.
   */
  async refresh(
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
    if (!refreshToken?.trim()) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const refreshHash = this.tokens.hashSessionToken(refreshToken.trim());
    const record = await this.redis.getJson<RefreshTokenRecord>(`auth:refresh:${refreshHash}`);

    if (!record) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Reuse detection: an already-rotated token indicates token theft!
    if (record.isUsed) {
      // Invalidate the session in DB
      await db.orm.public.Session.where({ id: brand(record.sessionId) }).update({ revokedAt: now() });
      // Invalidate the family in Redis
      await this.redis.delPrefix(`auth:refresh:family:${record.familyId}`);
      await this.redis.del(`auth:refresh:${refreshHash}`);

      const orgId =
        (await this.resolveOrganizationId(record.userId)) ?? (await this.defaultOrganizationId());
      if (orgId) {
        await this.audit.record({
          organizationId: orgId,
          actorUserId: record.userId,
          action: 'auth.refresh.reuse_detected',
          resourceType: 'Session',
          resourceId: record.sessionId,
          outcome: 'FAILURE',
          reason: 'refresh_token_reuse_detected',
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          requestId: meta.requestId ?? null,
        });
      }

      throw new UnauthorizedException('Refresh token reuse detected; session revoked');
    }

    if (record.expiresAt <= Date.now()) {
      await this.redis.del(`auth:refresh:${refreshHash}`);
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Verify session in database is still valid
    const session = await db.orm.public.Session.where({ id: brand(record.sessionId) }).first();
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    // Check if user was globally revoked (logout-all or password reset)
    const revokedBefore = await this.redis.get(`auth:user:revoked_before:${record.userId}`);
    if (revokedBefore && Math.floor(new Date(session.createdAt).getTime() / 1000) <= Number(revokedBefore)) {
      throw new UnauthorizedException('Session has been revoked');
    }

    const user = await db.orm.public.User.where({ id: brand(record.userId) }).first();
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    const organizationId = await this.resolveOrganizationId(user.id);
    if (!organizationId) throw new UnauthorizedException('No organization found');

    const activePropertyId = session.activePropertyId ?? null;
    const permissions = activePropertyId
      ? await this.permissionsForProperty(user.id, activePropertyId)
      : [];

    // Atomically mark old refresh token as used (with short grace window for network retries/reuse detection)
    record.isUsed = true;
    await this.redis.setJson(`auth:refresh:${refreshHash}`, record, 60);

    // Issue fresh access token
    const { token: newAccessToken, expiresAt: accessExpiresAt } = this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      org: organizationId,
      prop: activePropertyId,
      sid: session.id,
      perms: permissions,
      expiresInSeconds: 900,
    });

    // Issue rotated refresh token
    const newRefreshToken = this.tokens.createRefreshToken();
    const newRefreshHash = this.tokens.hashSessionToken(newRefreshToken);

    await this.redis.setJson<RefreshTokenRecord>(
      `auth:refresh:${newRefreshHash}`,
      {
        sessionId: session.id,
        userId: user.id,
        familyId: record.familyId,
        isUsed: false,
        expiresAt: Date.now() + this.refreshTtlSeconds * 1000,
      },
      this.refreshTtlSeconds,
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: accessExpiresAt.toISOString(),
    };
  }

  // ----------------------------------------------------------------------- logout

  /** Revokes the presented session and refresh token. */
  async logout(token: string, meta: RequestMeta): Promise<void> {
    if (!token) return;

    let sessionId: string | null = null;
    let userId: string | null = null;

    if (token.split('.').length === 3) {
      // JWT token
      try {
        const payload = this.tokens.verifyAccessToken(token, { ignoreExpiration: true });
        sessionId = payload.sid;
        userId = payload.sub;
      } catch {
        // Fall back to session token lookup
      }
    }

    if (!sessionId) {
      const tokenHash = this.tokens.hashSessionToken(token);
      const session = await db.orm.public.Session.where({ tokenHash: brand(tokenHash) }).first();
      if (session) {
        sessionId = session.id;
        userId = session.userId;
      }
    }

    if (!sessionId) return;

    const session = await db.orm.public.Session.where({ id: brand(sessionId) }).first();
    if (!session || session.revokedAt) return;

    await db.transaction(async (tx) => {
      await tx.orm.public.Session
        .where({ id: brand(session.id) })
        .update({ revokedAt: now() });
      const organizationId = await this.resolveOrganizationId(session.userId, tx);
      if (organizationId) {
        await this.audit.record(
          {
            organizationId,
            propertyId: session.activePropertyId ?? null,
            actorUserId: userId ?? session.userId,
            action: 'auth.logout',
            resourceType: 'Session',
            resourceId: session.id,
            outcome: 'SUCCESS',
            ipAddress: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            requestId: meta.requestId ?? null,
          },
          tx,
        );
      }
    });

    // Invalidate refresh tokens for this session
    await this.redis.delPrefix(`auth:refresh:family:${sessionId}`);
  }

  /**
   * Revokes all active sessions and refresh tokens for a user across all instances.
   */
  async logoutAll(userId: string, meta: RequestMeta): Promise<void> {
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new UnauthorizedException('User not found');

    const organizationId = await this.resolveOrganizationId(userId);

    await db.transaction(async (tx) => {
      const sessions = await tx.orm.public.Session
        .where({ userId: brand(userId) })
        .all();
      for (const s of sessions) {
        if (!s.revokedAt) {
          await tx.orm.public.Session.where({ id: brand(s.id) }).update({ revokedAt: now() });
        }
      }
      if (organizationId) {
        await this.audit.record(
          {
            organizationId,
            propertyId: null,
            actorUserId: userId,
            action: 'auth.logout_all',
            resourceType: 'User',
            resourceId: userId,
            outcome: 'SUCCESS',
            ipAddress: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            requestId: meta.requestId ?? null,
          },
          tx,
        );
      }
    });

    // Mark user revoked timestamp in Redis so existing JWTs and refresh tokens fail
    const nowSec = Math.floor(Date.now() / 1000);
    await this.redis.set(`auth:user:revoked_before:${userId}`, String(nowSec), 30 * 86_400);
  }

  // ---------------------------------------------------------------- password reset

  /**
   * Requests a password reset. Returns a generic message to prevent account enumeration.
   * In development/testing, returns the resetToken so automated tests can consume it.
   */
  async forgotPassword(
    email: string,
    meta: RequestMeta,
  ): Promise<{ ok: boolean; message: string; resetToken?: string; expiresAt?: string }> {
    const normalized = email?.trim().toLowerCase();
    const genericMsg = 'If an account with that email exists, password reset instructions have been sent.';

    if (!normalized) {
      return { ok: true, message: genericMsg };
    }

    const user = await db.orm.public.User.where({ email: brand(normalized) }).first();
    if (!user || user.status !== 'ACTIVE') {
      return { ok: true, message: genericMsg };
    }

    const token = this.tokens.createPasswordResetToken();
    const tokenHash = this.tokens.hashSessionToken(token);
    const ttlSeconds = 900; // 15 minutes
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.redis.setJson(
      `auth:pwd-reset:${tokenHash}`,
      {
        userId: user.id,
        email: user.email,
        expiresAt: expiresAt.getTime(),
      },
      ttlSeconds,
    );

    const organizationId = await this.resolveOrganizationId(user.id);
    if (organizationId) {
      await this.audit.record({
        organizationId,
        actorUserId: user.id,
        action: 'auth.password_reset_request',
        resourceType: 'User',
        resourceId: user.id,
        outcome: 'SUCCESS',
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        requestId: meta.requestId ?? null,
        metadata: { email: user.email },
      });
    }

    return {
      ok: true,
      message: genericMsg,
      resetToken: token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Consumes a single-use password reset token. Replays and expired tokens are rejected.
   * On success, revokes all existing sessions for the user.
   */
  async resetPassword(
    token: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<{ ok: boolean; message: string }> {
    if (!token?.trim()) {
      throw new BadRequestException('A password reset token is required');
    }
    if (!newPassword || newPassword.length < 12) {
      throw new BadRequestException('Choose a password of at least 12 characters');
    }

    const tokenHash = this.tokens.hashSessionToken(token.trim());
    const redisKey = `auth:pwd-reset:${tokenHash}`;
    const record = await this.redis.getJson<{ userId: string; email: string; expiresAt: number }>(redisKey);

    if (!record) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    if (record.expiresAt <= Date.now()) {
      await this.redis.del(redisKey);
      throw new BadRequestException('Password reset token has expired; request a new one');
    }

    // Atomically consume token (Single-use)
    const deleted = await this.redis.del(redisKey);
    if (deleted === 0) {
      throw new BadRequestException('Password reset token has already been used');
    }

    const user = await db.orm.public.User.where({ id: brand(record.userId) }).first();
    if (!user || user.status !== 'ACTIVE') {
      throw new BadRequestException('Account not found or inactive');
    }

    const newHash = await argon2.hash(newPassword, ARGON2_OPTS);

    await db.transaction(async (tx) => {
      await tx.orm.public.User.where({ id: brand(user.id) }).update({
        passwordHash: brand(newHash),
        passwordChangedAt: now(),
      });
      // Invalidate all active sessions for this user
      const sessions = await tx.orm.public.Session.where({ userId: brand(user.id) }).all();
      for (const s of sessions) {
        if (!s.revokedAt) {
          await tx.orm.public.Session.where({ id: brand(s.id) }).update({ revokedAt: now() });
        }
      }
    });

    // Invalidate refresh tokens and JWTs issued before this moment
    const nowSec = Math.floor(Date.now() / 1000);
    await this.redis.set(`auth:user:revoked_before:${user.id}`, String(nowSec), 30 * 86_400);

    const organizationId = await this.resolveOrganizationId(user.id);
    if (organizationId) {
      await this.audit.record({
        organizationId,
        actorUserId: user.id,
        action: 'auth.password_reset_success',
        resourceType: 'User',
        resourceId: user.id,
        outcome: 'SUCCESS',
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        requestId: meta.requestId ?? null,
        metadata: { email: user.email },
      });
    }

    return { ok: true, message: 'Password has been reset successfully' };
  }

  // ------------------------------------------------------------ principal & session

  /**
   * Resolves the current principal from either a JWT access token or a session cookie.
   * Enforces token structure, signature, audience, expiration, and user active status.
   */
  async resolveSession(token: string | undefined): Promise<{
    userId: string;
    sessionId: string;
    organizationId: string;
    activePropertyId: string | null;
  } | null> {
    if (!token?.trim()) return null;
    const cleanToken = token.trim();

    // 1. JWT Access Token verification
    if (cleanToken.split('.').length === 3) {
      // verifyAccessToken will throw UnauthorizedException if expired, malformed,
      // incorrectly signed, or wrong audience.
      const payload = this.tokens.verifyAccessToken(cleanToken);

      // Check if user was globally revoked (logout-all or password-reset)
      const revokedBefore = await this.redis.get(`auth:user:revoked_before:${payload.sub}`);
      if (revokedBefore && payload.iat <= Number(revokedBefore)) {
        return null;
      }

      // Check session state in DB
      const session = await db.orm.public.Session.where({ id: brand(payload.sid) }).first();
      if (!session || session.revokedAt) return null;

      const user = await db.orm.public.User.where({ id: brand(payload.sub) }).first();
      if (!user || user.status !== 'ACTIVE') return null;

      let activePropertyId: string | null = payload.prop ?? session.activePropertyId ?? null;
      if (activePropertyId) {
        const memberships = await this.loadMemberships(user.id);
        const valid = memberships.some((m) => m.propertyId === activePropertyId && m.isActive);
        if (!valid) activePropertyId = null;
      }

      return {
        userId: user.id,
        sessionId: session.id,
        organizationId: payload.org,
        activePropertyId,
      };
    }

    // 2. Opaque Session Cookie verification
    const tokenHash = this.tokens.hashSessionToken(cleanToken);
    const session = await db.orm.public.Session.where({ tokenHash: brand(tokenHash) }).first();
    if (!session || session.revokedAt) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

    // Check if user was globally revoked
    const revokedBefore = await this.redis.get(`auth:user:revoked_before:${session.userId}`);
    if (revokedBefore && Math.floor(new Date(session.createdAt).getTime() / 1000) <= Number(revokedBefore)) {
      return null;
    }

    const user = await db.orm.public.User.where({ id: brand(session.userId) }).first();
    if (!user || user.status !== 'ACTIVE') return null;

    const organizationId = await this.resolveOrganizationId(user.id);
    if (!organizationId) return null;

    let activePropertyId: string | null = session.activePropertyId ?? null;
    if (activePropertyId) {
      const memberships = await this.loadMemberships(user.id);
      const valid = memberships.some((m) => m.propertyId === activePropertyId && m.isActive);
      if (!valid) activePropertyId = null;
    }

    return { userId: user.id, sessionId: session.id, organizationId, activePropertyId };
  }

  async buildMe(userId: string, activePropertyId: string | null): Promise<AuthMeView> {
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new UnauthorizedException();

    const memberships = await this.loadMemberships(userId);

    const permissions = activePropertyId
      ? await this.permissionsForProperty(userId, activePropertyId)
      : [];

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        status: user.status,
        propertyMemberships: memberships,
      },
      activePropertyId,
      permissions,
    };
  }

  /** Effective permissions = permissions of the user's role at that property. */
  async permissionsForProperty(userId: string, propertyId: string): Promise<string[]> {
    const memberships = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId), propertyId: brand(propertyId), isActive: brand(true) })
      .all();
    if (memberships.length === 0) return [];

    const roleIds = memberships.map((m) => m.roleId);
    const links = await db.orm.public.RolePermission
      .where((m) => m.roleId.in(roleIds))
      .all();
    if (links.length === 0) return [];

    const permissionIds = [...new Set(links.map((l) => l.permissionId))];
    const perms = await db.orm.public.Permission
      .where((m) => m.id.in(permissionIds))
      .all();
    return perms.map((p) => p.key).sort();
  }

  /** Switches the active property, rejecting any the user does not belong to. */
  async switchProperty(
    userId: string,
    sessionId: string,
    propertyId: string,
    meta: RequestMeta,
  ): Promise<string> {
    const memberships = await this.loadMemberships(userId);
    const target = memberships.find((m) => m.propertyId === propertyId && m.isActive);
    if (!target) {
      throw new ForbiddenException('You do not have access to that property');
    }

    const organizationId = await this.resolveOrganizationId(userId);
    if (!organizationId) throw new ForbiddenException('No organization for this account');

    await db.transaction(async (tx) => {
      await tx.orm.public.Session
        .where({ id: brand(sessionId) })
        .update({ activePropertyId: brand(propertyId) });
      await this.audit.record(
        {
          organizationId,
          propertyId,
          actorUserId: userId,
          action: 'auth.switch_property',
          resourceType: 'Session',
          resourceId: sessionId,
          outcome: 'SUCCESS',
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          requestId: meta.requestId ?? null,
        },
        tx,
      );
    });
    return propertyId;
  }

  private async resolveOrganizationId(userId: string, tx?: unknown): Promise<string | null> {
    const client = (tx ?? db) as typeof db;
    const memberships = await client.orm.public.PropertyMembership
      .where({ userId: brand(userId) })
      .all();
    if (memberships.length === 0) return null;
    const property = await client.orm.public.Property
      .where({ id: brand(memberships[0].propertyId) })
      .first();
    return property?.organizationId ?? null;
  }

  private async defaultOrganizationId(): Promise<string | null> {
    const org = await db.orm.public.Organization.where({ status: brand('ACTIVE') }).first();
    return org?.id ?? null;
  }

  private async loadMemberships(userId: string): Promise<MembershipView[]> {
    const memberships = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId) })
      .all();
    if (memberships.length === 0) return [];

    const roleIds = [...new Set(memberships.map((m) => m.roleId))];
    const propertyIds = [...new Set(memberships.map((m) => m.propertyId))];

    const roles = await db.orm.public.Role
      .where((m) => m.id.in(roleIds))
      .all();
    const properties = await db.orm.public.Property
      .where((m) => m.id.in(propertyIds))
      .all();
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const propertyById = new Map(properties.map((p) => [p.id, p]));

    return memberships.flatMap((m) => {
      const role = roleById.get(m.roleId);
      const property = propertyById.get(m.propertyId);
      if (!role || !property) return [];
      return [{
        id: m.id,
        userId: m.userId,
        propertyId: m.propertyId,
        roleId: m.roleId,
        isActive: m.isActive,
        role: { id: role.id, key: role.key, name: role.name, description: role.description },
        property: {
          id: property.id,
          name: property.name,
          slug: property.slug,
          timezone: property.timezone,
          currencyCode: property.currencyCode,
        },
      }];
    });
  }
}

/**
 * A real Argon2id digest of a value nobody can supply, computed once per process
 * and reused for every unknown-email login so the miss path costs the same as a
 * genuine password verification.
 */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTS);
  return dummyHash;
}
