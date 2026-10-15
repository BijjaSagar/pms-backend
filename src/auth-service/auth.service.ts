import {
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

@Injectable()
export class AuthService {
  constructor(
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  private get sessionTtlMs(): number {
    const hours = Number(this.config.get<number>('session.ttlHours') ?? 12);
    return hours * 60 * 60 * 1000;
  }

  /**
   * Verifies credentials and opens a session.
   *
   * Failure modes are deliberately indistinguishable to the caller: an unknown
   * email, a disabled account and a wrong password all raise the same message,
   * so the endpoint cannot be used to enumerate valid accounts.
   */
  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; userId: string; organizationId: string; activePropertyId: string | null }> {
    const normalized = email.trim().toLowerCase();
    const user = await db.orm.public.User.where({ email: brand(normalized) }).first();

    // Always run a real hash comparison so response time does not reveal whether
    // the email exists. A real digest of an unguessable value is used for the
    // miss path; an invalid hash would be rejected on parse and reintroduce
    // exactly the timing signal this is meant to remove.
    const hash = user?.passwordHash ?? (await getDummyHash());
    const ok = await argon2.verify(hash, password).catch(() => false);

    const organizationId = user ? await this.resolveOrganizationId(user.id) : null;

    // A user with no property membership has no organization context and cannot
    // be admitted; treat it like any other authentication failure.
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

    // Default the session to the user's first active membership.
    const memberships = await this.loadMemberships(user.id);
    const active = memberships.find((m) => m.isActive) ?? null;

    const token = this.tokens.createSessionToken();
    const tokenHash = this.tokens.hashSessionToken(token);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);

    // Session row, lastLoginAt and the audit row commit together, so a failed
    // write can never leave a live session without its audit evidence.
    await db.transaction(async (tx) => {
      await tx.orm.public.Session.create({
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
          outcome: 'SUCCESS',
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          requestId: meta.requestId ?? null,
        },
        tx,
      );
    });

    return {
      token,
      expiresAt,
      userId: user.id,
      organizationId,
      activePropertyId: active?.propertyId ?? null,
    };
  }

  /** Revokes the presented session. Idempotent. */
  async logout(token: string, meta: RequestMeta): Promise<void> {
    const tokenHash = this.tokens.hashSessionToken(token);
    const session = await db.orm.public.Session.where({ tokenHash: brand(tokenHash) }).first();
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
            actorUserId: session.userId,
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
  }

  /**
   * Resolves the current principal from a raw session cookie.
   *
   * Returns null for any failure: unknown token, expired, revoked, or the owning
   * account no longer ACTIVE. Disabling a user therefore ends their sessions
   * immediately without needing to sweep rows.
   */
  async resolveSession(token: string | undefined): Promise<{
    userId: string;
    sessionId: string;
    organizationId: string;
    activePropertyId: string | null;
  } | null> {
    if (!token) return null;
    const tokenHash = this.tokens.hashSessionToken(token);
    const session = await db.orm.public.Session.where({ tokenHash: brand(tokenHash) }).first();
    if (!session) return null;
    if (session.revokedAt) return null;
    // Reads return timestamps as branded strings, so rehydrate before comparing.
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

    const user = await db.orm.public.User.where({ id: brand(session.userId) }).first();
    if (!user || user.status !== 'ACTIVE') return null;

    const organizationId = await this.resolveOrganizationId(user.id);
    if (!organizationId) return null;

    // The active property must still be one this user actually belongs to.
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

  private async loadMemberships(userId: string): Promise<MembershipView[]> {
    const memberships = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId) })
      .all();
    if (memberships.length === 0) return [];

    // The contract client's join API is not usable in this release, so the
    // related role and property rows are fetched explicitly and stitched here.
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
