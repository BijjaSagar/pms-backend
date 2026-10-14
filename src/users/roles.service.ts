import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { decideRoleGrant } from '../users/escalation.policy.js';

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

  private async context(req: any) {
    const propertyId = req.user?.activePropertyId;
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

  async list(req: any) {
    const { organizationId } = await this.context(req);
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
  async matrix(req: any) {
    const { organizationId } = await this.context(req);
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
  async setRolePermissions(req: any, roleKey: string, permissionKeys: string[]) {
    const { property, organizationId } = await this.context(req);
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
      grantorPermissions: (req.user?.permissions ?? []) as string[],
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
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'role.manage',
      resourceType: 'Role',
      resourceId: role.id,
      outcome: 'SUCCESS',
      metadata: { roleKey, added: toAdd.map((p) => p.key), removed: toRemove.length },
    });

    return { roleKey, permissions: wanted.map((p) => p.key).sort() };
  }
}

/**
 * Tax rules.
 *
 * Gated on `role.manage` rather than `invoice.issue`. Front Desk holds
 * `invoice.issue`, and letting the front desk change GST mid-shift would change
 * how every subsequent charge is taxed — a pricing decision made by whoever
 * happened to be on the desk, with no record of who set it.
 */
@Injectable()
export class TaxRulesService {
  constructor(private readonly audit: AuditService) {}

  private async property(req: any) {
    const propertyId = req.user?.activePropertyId;
    if (!propertyId) throw new BadRequestException('Select an active property first');
    const property = await db.orm.public.Property.where({ id: brand(propertyId) }).first();
    if (!property) throw new BadRequestException('Active property not found');
    return property;
  }

  async list(req: any) {
    const property = await this.property(req);
    const rules = await db.orm.public.TaxRule.where({ propertyId: brand(property.id) }).all();
    return rules
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        ratePercent: String(r.ratePercent),
        appliesTo: r.appliesTo,
        isInclusive: r.isInclusive,
        isCompound: r.isCompound,
        isActive: r.isActive,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  async create(req: any, input: {
    code: string; name: string; ratePercent: number;
    appliesTo?: string; isInclusive?: boolean;
  }) {
    const property = await this.property(req);
    const code = input.code?.trim();
    if (!code) throw new BadRequestException('A tax rule requires a code');
    if (!Number.isFinite(input.ratePercent) || input.ratePercent < 0) {
      throw new BadRequestException('Rate must be a non-negative number');
    }

    const existing = await db.orm.public.TaxRule
      .where({ propertyId: brand(property.id), code: brand(code) })
      .first();
    if (existing) throw new BadRequestException(`A rule with code ${code} already exists`);

    const rule = await db.orm.public.TaxRule.create({
      propertyId: brand(property.id),
      code: brand(code),
      name: brand(input.name?.trim() || code),
      ratePercent: brand(String(input.ratePercent)),
      appliesTo: brand(input.appliesTo ?? 'ALL') as never,
      isInclusive: brand(input.isInclusive ?? false),
      isCompound: brand(false),
      isActive: brand(true),
    });

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'tax.rule.create',
      resourceType: 'TaxRule',
      resourceId: rule.id,
      outcome: 'SUCCESS',
      metadata: { code, ratePercent: input.ratePercent, inclusive: rule.isInclusive },
    });

    return { id: rule.id, code: rule.code, ratePercent: String(rule.ratePercent) };
  }

  async update(req: any, id: string, patch: { ratePercent?: number; isActive?: boolean; name?: string }) {
    const property = await this.property(req);
    const rule = await db.orm.public.TaxRule
      .where({ id: brand(id), propertyId: brand(property.id) })
      .first();
    if (!rule) throw new BadRequestException('Tax rule not found at this property');

    const updates: Record<string, unknown> = {};
    if (patch.ratePercent !== undefined) {
      if (!Number.isFinite(patch.ratePercent) || patch.ratePercent < 0) {
        throw new BadRequestException('Rate must be a non-negative number');
      }
      updates.ratePercent = brand(String(patch.ratePercent));
    }
    if (patch.isActive !== undefined) updates.isActive = brand(patch.isActive);
    if (patch.name?.trim()) updates.name = brand(patch.name.trim());

    if (Object.keys(updates).length === 0) return { idempotent: true, id };

    await db.orm.public.TaxRule.where({ id: brand(id) }).update(updates);

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId: property.id,
      actorUserId: req.user?.id,
      action: 'tax.rule.update',
      resourceType: 'TaxRule',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: {
        code: rule.code,
        fromRate: String(rule.ratePercent),
        toRate: patch.ratePercent ?? String(rule.ratePercent),
        isActive: patch.isActive ?? rule.isActive,
      },
    });

    return { idempotent: false, id, ...(patch.ratePercent !== undefined ? { ratePercent: String(patch.ratePercent) } : {}) };
  }
}