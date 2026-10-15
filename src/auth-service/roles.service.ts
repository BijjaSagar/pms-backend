import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { decideRoleGrant } from './escalation.policy.js';
import type { ActorContext } from '../contracts/auth.messages.js';

/**
 * Role catalogue and the permission matrix.
 *
 * Roles are `isSystem`, meaning they come from the seed and are shared by every
 * organisation of this deployment. They are reported, never edited here: the
 * definitions live in the seed so they stay versioned and re-runnable, which is
 * what §9.2 asks for.
 */
@Injectable()
export class RolesService {
  constructor(private readonly audit: AuditService) {}

  private async context(actor: ActorContext) {
    const propertyId = actor.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    const property = await db.orm.public.Property.where({ id: brand(propertyId) }).first();
    if (!property) throw new BadRequestException('Active property not found');
    return { property, organizationId: property.organizationId };
  }

  private async permissionsFor(roleIds: string[]) {
    if (roleIds.length === 0) return new Map<string, string[]>();
    const links = await db.orm.public.RolePermission
      .where((m) => m.roleId.in(roleIds))
      .all();
    if (links.length === 0) return new Map<string, string[]>();

    const permIds = [...new Set(links.map((l) => l.permissionId))];
    const perms = await db.orm.public.Permission.where((m) => m.id.in(permIds)).all();
    const permById = new Map(perms.map((p: any) => [p.id, p]));

    const out = new Map<string, string[]>();
    for (const l of links) {
      const perm = permById.get(l.permissionId);
      if (!perm) continue;
      const list = out.get(l.roleId) ?? [];
      list.push(perm.key);
      out.set(l.roleId, list);
    }
    for (const list of out.values()) list.sort();
    return out;
  }

  async list(actor: ActorContext) {
    const { organizationId } = await this.context(actor);
    const roles = await db.orm.public.Role
      .where({ organizationId: brand(organizationId) })
      .all();
    const permsByRole = await this.permissionsFor(roles.map((r) => r.id));

    const memberships = await db.orm.public.PropertyMembership.where({}).all();
    const counts: Record<string, number> = {};
    for (const m of memberships) {
      if (!m.isActive) continue;
      counts[m.roleId] = (counts[m.roleId] ?? 0) + 1;
    }

    return roles
      .map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        isActive: r.isActive,
        permissions: permsByRole.get(r.id) ?? [],
        memberCount: counts[r.id] ?? 0,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** The permission catalogue with plain-language descriptions. */
  async permissions() {
    const perms = await db.orm.public.Permission.where({}).all();
    return perms
      .map((p) => ({
        key: p.key,
        resource: p.resource,
        action: p.action,
        description: p.description ?? `${p.action} ${p.resource}`,
      }))
      .sort((a, b) => a.resource.localeCompare(b.resource) || a.action.localeCompare(b.action));
  }

  /**
   * Permission × role matrix.
   *
   * Grouped by resource rather than as one flat list, because 63 permissions in
   * alphabetical order is not something anyone can read.
   */
  async matrix(actor: ActorContext) {
    const { organizationId } = await this.context(actor);
    const roles = await db.orm.public.Role
      .where({ organizationId: brand(organizationId), isActive: brand(true) })
      .all();
    const perms = await this.permissions();
    const permsByRole = await this.permissionsFor(roles.map((r) => r.id));

    const groups = new Map<string, typeof perms>();
    for (const p of perms) {
      if (!groups.has(p.resource)) groups.set(p.resource, []);
      groups.get(p.resource)!.push(p);
    }

    return {
      roles: roles.map((r) => ({ key: r.key, name: r.name })),
      resources: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([resource, list]) => ({
          resource,
          permissions: list.map((p) => ({
            key: p.key,
            action: p.action,
            description: p.description,
            roles: roles
              .filter((r) => (permsByRole.get(r.id) ?? []).includes(p.key))
              .map((r) => r.key),
          })),
        })),
    };
  }

  /**
   * Grants a permission to a custom role.
   *
   * System roles are refused: their definitions belong to the seed, and editing
   * one at runtime would drift from what a fresh database produces. The
   * escalation rule applies here too, so a delegated granter cannot hand out a
   * permission they do not themselves hold.
   */
  async setRolePermissions(actor: ActorContext, roleKey: string, permissionKeys: string[]) {
    const { property, organizationId } = await this.context(actor);
    const roles = await db.orm.public.Role.where({ organizationId: brand(organizationId) }).all();
    const role = roles.find((r) => r.key === roleKey);
    if (!role) throw new BadRequestException(`Unknown role: ${roleKey}`);
    if (role.isSystem) {
      throw new ForbiddenException(
        'System roles are defined by the seed and cannot be edited at runtime.',
      );
    }

    const all = await db.orm.public.Permission.where({}).all();
    const byKey = new Map<string, any>(all.map((p: any) => [String(p.key), p]));
    const unknown = permissionKeys.filter((k) => !byKey.has(k));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${unknown.join(', ')}`);
    }

    const decision = decideRoleGrant({
      grantorPermissions: actor.permissions ?? [],
      targetPermissions: permissionKeys,
      targetIsSystemRole: false,
      grantingSelf: false,
    });
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    const wanted = permissionKeys.map((k) => byKey.get(k)!);
    const existing = await db.orm.public.RolePermission.where({ roleId: brand(role.id) }).all();

    const toAdd = wanted.filter((w) => !existing.some((e) => e.permissionId === w.id));
    const toRemove = existing.filter((e) => !wanted.some((w) => w.id === e.permissionId));

    for (const add of toAdd) {
      await db.orm.public.RolePermission.create({
        roleId: brand(role.id),
        permissionId: brand(add.id),
      });
    }
    for (const rm of toRemove) {
      await db.orm.public.RolePermission.where({ roleId: brand(rm.roleId), permissionId: brand(rm.permissionId) }).deleteAll();
    }

    await this.audit.record({
      organizationId: actor.organizationId,
      propertyId: property.id,
      actorUserId: actor.id,
      action: 'role.manage',
      resourceType: 'Role',
      resourceId: role.id,
      outcome: 'SUCCESS',
      metadata: { roleKey, added: toAdd.map((p) => p.key), removed: toRemove.length },
    });

    return { roleKey, permissions: wanted.map((p) => p.key).sort() };
  }
}
