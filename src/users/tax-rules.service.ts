import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Tax rules.
 *
 * Gated on `role.manage` rather than `invoice.issue`. Front Desk holds
 * `invoice.issue`, and letting the front desk change GST mid-shift would change
 * how every subsequent charge is taxed — a pricing decision made by whoever
 * happened to be on the desk, with no record of who set it.
 *
 * This is property configuration, not authorization state, so it stays in the
 * gateway while the role and permission catalogue moved to the auth
 * microservice.
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
