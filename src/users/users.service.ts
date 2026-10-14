import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { db } from '../prisma/db.js';
import { brand, now, ts } from '../prisma/compat.js';
import { parseTimestamp } from '../common/dates.js';
import { ARGON2_OPTS } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { decideAccountChange, decideRoleGrant } from './escalation.policy.js';

/**
 * Staff administration.
 *
 * Reading the staff list and changing it are separate permissions on purpose:
 * a manager needs to see who is on shift, but must not be able to invite,
 * disable or re-role anyone. Every mutation here writes an audit row, because
 * "who gave whom which role" is the question an administrator is asked months
 * later and there is no other record of it.
 */
@Injectable()
export class UsersService {
  constructor(private readonly audit: AuditService) {}

  private async context(req: any) {
    const propertyId = req.user?.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    const property = await db.orm.public.Property.where({ id: brand(propertyId) }).first();
    if (!property) throw new BadRequestException('Active property not found');
    return { property, organizationId: property.organizationId };
  }

  private permissionsOf(req: any): string[] {
    return (req.user?.permissions ?? []) as string[];
  }

  private async roleByKey(organizationId: string, key: string) {
    const roles = await db.orm.public.Role.where({ organizationId: brand(organizationId) }).all();
    return roles.find((r) => r.key === key);
  }

  private async permissionsOfRole(roleId: string): Promise<string[]> {
    const links = await db.orm.public.RolePermission.where({ roleId: brand(roleId) }).all();
    if (links.length === 0) return [];
    const perms = await db.orm.public.Permission
      .where((m) => m.id.in(links.map((l) => l.permissionId)))
      .all();
    return perms.map((p) => p.key);
  }

  // ------------------------------------------------------------------- reads

  /**
   * Staff list, scoped to the active property.
   *
   * A user's memberships at other properties are counted but not detailed: an
   * administrator of one property has no business enumerating another
   * property's team.
   */
  async list(req: any) {
    const { property } = await this.context(req);

    const memberships = await db.orm.public.PropertyMembership
      .where({ propertyId: brand(property.id), isActive: brand(true) })
      .all();
    const allMemberships = await db.orm.public.PropertyMembership
      .where({ propertyId: brand(property.id) })
      .all();

    const userIds = [...new Set(allMemberships.map((m) => m.userId))];
    const users = userIds.length
      ? await db.orm.public.User.where((m) => m.id.in(userIds)).all()
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const roleIds = [...new Set(allMemberships.map((m) => m.roleId))];
    const roles = roleIds.length
      ? await db.orm.public.Role.where((m) => m.id.in(roleIds)).all()
      : [];
    const roleById = new Map(roles.map((r) => [r.id, r]));

    return allMemberships
      .map((m) => {
        const user = userById.get(m.userId);
        if (!user) return null;
        const role = roleById.get(m.roleId);
        const pending =
          user.status === 'INVITED' &&
          (user.inviteExpiresAt === null || parseTimestamp(user.inviteExpiresAt) > new Date());
        return {
          userId: user.id,
          email: user.email,
          fullName: user.fullName,
          status: user.status,
          lastLoginAt: user.lastLoginAt,
          invitedAt: m.invitedAt,
          acceptedAt: m.acceptedAt,
          membershipActive: m.isActive,
          // A lapsed invite is reported as such rather than looking like a
          // pending invitation that is simply taking its time.
          invitePending: pending,
          inviteExpired:
            user.status === 'INVITED' &&
            user.inviteExpiresAt !== null &&
            parseTimestamp(user.inviteExpiresAt) <= new Date(),
          membershipId: m.id,
          propertyId: m.propertyId,
          roleKey: role?.key ?? null,
          roleName: role?.name ?? null,
          isSystemRole: role?.isSystem ?? false,
          activeMembershipCount: memberships.filter((x) => x.userId === m.userId).length,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.fullName.localeCompare(b.fullName));
  }

  async get(req: any, userId: string) {
    const rows = await this.list(req);
    const found = rows.find((r: any) => r.userId === userId);
    if (!found) throw new NotFoundException('No such staff member at this property');
    return found;
  }

  // ------------------------------------------------------------------ invite

  /**
   * Invites a person: creates an INVITED account and an active membership.
   *
   * There is no mail in this system, so the accept link is returned for the
   * administrator to pass on. Claiming an email was sent would be worse than
   * being explicit that it was not.
   */
  async invite(req: any, input: {
    email: string;
    fullName: string;
    propertyId?: string;
    roleKey: string;
    expiresAt?: string | null;
  }) {
    const { property, organizationId } = await this.context(req);

    const email = input.email?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required');
    }
    if (!input.fullName?.trim()) throw new BadRequestException('A name is required');

    const targetProperty = input.propertyId ?? property.id;
    if (targetProperty !== property.id) {
      throw new ForbiddenException('You can only invite staff to your active property.');
    }

    const role = await this.roleByKey(organizationId, input.roleKey);
    if (!role) throw new NotFoundException(`Unknown role: ${input.roleKey}`);
    if (!role.isActive) throw new BadRequestException('That role is not active');

    // The grant check runs before anything is written.
    const targetPermissions = await this.permissionsOfRole(role.id);
    const decision = decideRoleGrant({
      grantorPermissions: this.permissionsOf(req),
      targetPermissions,
      targetIsSystemRole: role.isSystem,
      grantingSelf: false,
    });
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    const existing = await db.orm.public.User.where({ email: brand(email) }).first();
    if (existing && existing.status === 'ACTIVE') {
      throw new ConflictException('That email already belongs to an active account');
    }
    if (
      existing &&
      existing.status === 'INVITED' &&
      existing.inviteToken &&
      (!existing.inviteExpiresAt || parseTimestamp(existing.inviteExpiresAt) > new Date())
    ) {
      // Re-inviting here would quietly replace the token, so any link the
      // administrator had already passed on would be dead on arrival. Reissue
      // is the explicit way to do that.
      throw new ConflictException(
        'That address already has a pending invitation. Use reissue-invite to send a new link.',
      );
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 7 * 86_400_000);

    const user = existing ?? (await db.orm.public.User.create({
      email: brand(email),
      fullName: brand(input.fullName.trim()),
      status: brand('INVITED'),
      inviteToken: brand(token),
      inviteExpiresAt: ts(expiresAt),
    }));

    if (existing) {
      await db.orm.public.User.where({ id: brand(user.id) }).update({
        fullName: brand(input.fullName.trim()),
        status: brand('INVITED'),
        inviteToken: brand(token),
        inviteExpiresAt: ts(expiresAt),
      });
    }

    const membership = await db.orm.public.PropertyMembership.create({
      userId: brand(user.id),
      propertyId: brand(targetProperty),
      roleId: brand(role.id),
      isActive: brand(true),
      invitedAt: now(),
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: targetProperty,
      actorUserId: req.user?.id,
      action: 'user.invite',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: {
        email,
        roleKey: role.key,
        membershipId: membership.id,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return {
      userId: user.id,
      email,
      fullName: user.fullName,
      status: 'INVITED',
      roleKey: role.key,
      // Reported so the caller knows exactly which property the membership was
      // created on, rather than inferring it from the active-property switch.
      propertyId: targetProperty,
      inviteExpiresAt: expiresAt.toISOString(),
      // Returned rather than emailed: this system sends no mail.
      acceptUrl: `/accept-invite?token=${token}`,
      inviteToken: token,
    };
  }

  /** Issues a fresh token, invalidating the previous one. */
  async reissueInvite(req: any, userId: string, expiresAt?: string | null) {
    const { property } = await this.context(req);
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new NotFoundException('User not found');
    if (user.status === 'ACTIVE') {
      throw new ConflictException('That account is already active; nothing to invite');
    }

    const token = randomBytes(32).toString('hex');
    const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 7 * 86_400_000);
    await db.orm.public.User.where({ id: brand(userId) }).update({
      inviteToken: brand(token),
      inviteExpiresAt: ts(expiry),
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'user.invite.reissue',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: { email: user.email, expiresAt: expiry.toISOString() },
    });

    return {
      userId,
      acceptUrl: `/accept-invite?token=${token}`,
      inviteToken: token,
      inviteExpiresAt: expiry.toISOString(),
    };
  }

  /**
   * Consumes an invitation.
   *
   * Deliberately unauthenticated: the token is the credential. It is cleared on
   * success so it cannot be replayed, and expiry is enforced here rather than
   * only in the UI.
   */
  async acceptInvite(token: string, password: string) {
    if (!token?.trim()) throw new BadRequestException('An invitation token is required');
    if (!password || password.length < 12) {
      throw new BadRequestException('Choose a password of at least 12 characters');
    }

    // Looked up by the unique index directly rather than scanning every user, so a
    // valid token cannot be missed by a filter the driver applies differently.
    const user = await db.orm.public.User
      .where({ inviteToken: brand(token.trim()) })
      .first();
    if (!user) throw new NotFoundException('That invitation is not valid');
    if (user.status === 'ACTIVE') {
      throw new ConflictException('That invitation has already been used');
    }
    if (user.inviteExpiresAt && parseTimestamp(user.inviteExpiresAt) <= new Date()) {
      throw new BadRequestException('That invitation has expired; ask for a new one');
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.User.where({ id: brand(user.id) }).update({
        passwordHash: brand(await argon2.hash(password, ARGON2_OPTS)),
        status: brand('ACTIVE'),
        emailVerifiedAt: now(),
        passwordChangedAt: now(),
        // One-time: a used token is worthless afterwards.
        inviteToken: brand(null),
      });
      const memberships = await tx.orm.public.PropertyMembership
        .where({ userId: brand(user.id) })
        .all();
      for (const m of memberships) {
        await tx.orm.public.PropertyMembership.where({ id: brand(m.id) }).update({
          acceptedAt: now(),
        });
      }
    });

    await this.audit.record({
      // There is no request context here, so the organisation is resolved from
      // the membership the invitation created. An empty string is not a valid
      // uuid and would fail the write.
      organizationId: await this.organizationOf(user.id),
      propertyId: null,
      actorUserId: user.id,
      action: 'user.invite.accept',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: { email: user.email },
    });

    return { email: user.email, status: 'ACTIVE' };
  }

  // ------------------------------------------------------------------ updates

  /** Changes the role held at a property. Audited, and escalation-checked. */
  async setRole(req: any, userId: string, propertyId: string, roleKey: string) {
    const { property, organizationId } = await this.context(req);

    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new NotFoundException('User not found');

    const membership = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId), propertyId: brand(propertyId) })
      .first();
    if (!membership) throw new NotFoundException('No membership at that property');

    const role = await this.roleByKey(organizationId, roleKey);
    if (!role) throw new NotFoundException(`Unknown role: ${roleKey}`);

    const currentRole = await db.orm.public.Role.where({ id: brand(membership.roleId) }).first();
    if (currentRole?.key === roleKey) {
      return { idempotent: true, userId, roleKey };
    }

    const isSelf = req.user?.id === userId;
    const currentIsAdmin = currentRole?.key === 'ADMIN';

    // Removing the last admin is refused before the permission check so the
    // message is about lockout rather than about escalation.
    if (currentIsAdmin) {
      const decision = decideAccountChange({
        activeAdminMemberships: await this.activeAdminCount(organizationId),
        removesAdmin: roleKey !== 'ADMIN',
        disablesAccount: false,
        isSelf,
      });
      if (!decision.allowed) throw new ConflictException(decision.reason);
    }

    const targetPermissions = await this.permissionsOfRole(role.id);
    const decision = decideRoleGrant({
      grantorPermissions: this.permissionsOf(req),
      targetPermissions,
      targetIsSystemRole: role.isSystem,
      grantingSelf: isSelf,
    });
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    await db.orm.public.PropertyMembership.where({ id: brand(membership.id) }).update({
      roleId: brand(role.id),
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: propertyId,
      actorUserId: req.user?.id,
      action: 'role.assign',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
      metadata: { fromRole: currentRole?.key ?? null, toRole: role.key, membershipId: membership.id },
    });

    return { idempotent: false, userId, roleKey: role.key, previousRoleKey: currentRole?.key ?? null };
  }

  /** Enables or disables an account, revoking its sessions when disabled. */
  async setStatus(req: any, userId: string, status: 'ACTIVE' | 'DISABLED') {
    const { property, organizationId } = await this.context(req);
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new NotFoundException('User not found');
    if (user.status === status) return { idempotent: true, userId, status };

    const isSelf = req.user?.id === userId;
    if (status === 'DISABLED') {
      const memberships = await db.orm.public.PropertyMembership
        .where({ userId: brand(userId), isActive: brand(true) })
        .all();
      const roles = memberships.length
        ? await db.orm.public.Role
            .where((m) => m.id.in(memberships.map((m) => m.roleId)))
            .all()
        : [];
      const isAdmin = roles.some((r) => r.key === 'ADMIN');
      const decision = decideAccountChange({
        activeAdminMemberships: await this.activeAdminCount(organizationId),
        removesAdmin: isAdmin,
        disablesAccount: true,
        isSelf,
      });
      if (!decision.allowed) throw new ConflictException(decision.reason);
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.User.where({ id: brand(userId) }).update({
        status: brand(status),
      });
      if (status === 'DISABLED') {
        // Revoking sessions is the point: a disabled account that keeps its
        // cookies is still a working account.
        const sessions = await tx.orm.public.Session.where({ userId: brand(userId) }).all();
        for (const s of sessions) {
          await tx.orm.public.Session.where({ id: brand(s.id) }).deleteAll();
        }
      }
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: status === 'DISABLED' ? 'user.deactivate' : 'user.activate',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
      metadata: { email: user.email, from: user.status, to: status },
    });

    return { idempotent: false, userId, status };
  }

  async updateProfile(req: any, userId: string, patch: { fullName?: string }) {
    const { property } = await this.context(req);
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new NotFoundException('User not found');

    const updates: Record<string, unknown> = {};
    if (patch.fullName?.trim()) updates.fullName = brand(patch.fullName.trim());

    if (Object.keys(updates).length > 0) {
      await db.orm.public.User.where({ id: brand(userId) }).update(updates);
      await this.audit.record({
        organizationId: req.user?.organizationId,
        propertyId: property.id,
        actorUserId: req.user?.id,
        action: 'user.update',
        resourceType: 'User',
        resourceId: userId,
        outcome: 'SUCCESS',
        metadata: { fields: Object.keys(patch) },
      });
    }

    return this.get(req, userId);
  }

  /** Cancels a pending invitation without touching the account itself. */
  async cancelInvite(req: any, userId: string) {
    const { property } = await this.context(req);
    const user = await db.orm.public.User.where({ id: brand(userId) }).first();
    if (!user) throw new NotFoundException('User not found');

    await db.orm.public.User.where({ id: brand(userId) }).update({ inviteToken: brand(null) });
    const membership = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId), propertyId: brand(property.id) })
      .first();
    if (membership) {
      await db.orm.public.PropertyMembership.where({ id: brand(membership.id) }).update({
        isActive: brand(false),
      });
    }

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'user.invite.cancel',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
      metadata: { email: user.email },
    });

    return { userId, inviteCancelled: true };
  }

  /** The organisation a user belongs to, via their first membership. */
  private async organizationOf(userId: string): Promise<string> {
    const memberships = await db.orm.public.PropertyMembership
      .where({ userId: brand(userId) })
      .all();
    for (const m of memberships) {
      const property = await db.orm.public.Property.where({ id: brand(m.propertyId) }).first();
      if (property) return property.organizationId;
    }
    return '';
  }

  private async activeAdminCount(organizationId: string): Promise<number> {
    const roles = await db.orm.public.Role.where({ organizationId: brand(organizationId) }).all();
    const adminRole = roles.find((r) => r.key === 'ADMIN');
    if (!adminRole) return 0;

    const memberships = await db.orm.public.PropertyMembership
      .where({ roleId: brand(adminRole.id), isActive: brand(true) })
      .all();
    const userIds = [...new Set(memberships.map((m) => m.userId))];
    if (userIds.length === 0) return 0;

    const users = await db.orm.public.User.where((m) => m.id.in(userIds)).all();
    return users.filter((u) => u.status === 'ACTIVE').length;
  }
}