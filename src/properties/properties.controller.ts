import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

class UpdatePropertyDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(100)
  timezone?: string;

  @IsOptional() @IsString() @Matches(/^[A-Za-z]{3}$/, { message: 'Use a 3-letter ISO currency code' })
  currencyCode?: string;

  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/, { message: 'Use a 2-letter ISO country code' })
  countryCode?: string;

  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use HH:MM in 24-hour time' })
  checkInTime?: string;

  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use HH:MM in 24-hour time' })
  checkOutTime?: string;

  @IsOptional() @IsBoolean()
  taxInclusivePricing?: boolean;

  @IsOptional() @IsString() @MaxLength(200)
  addressLine1?: string;

  @IsOptional() @IsString() @MaxLength(100)
  city?: string;
}

@Controller('properties')
export class PropertiesController {
  constructor(private readonly audit: AuditService) {}

  /** Properties the caller actually holds a membership for, never the whole org. */
  @RequirePermissions('property.read')
  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    const memberships = await db.orm.public.PropertyMembership
      .where({ userId: brand(req.user!.id), isActive: brand(true) })
      .all();
    if (memberships.length === 0) return [];

    const ids = [...new Set(memberships.map((m) => m.propertyId))];
    const rows = await db.orm.public.Property
      .where((m) => m.id.in(ids))
      .all();

    const roleById = new Map(
      (await db.orm.public.Role.where((m) => m.id.in(memberships.map((x) => x.roleId))).all())
        .map((r) => [r.id, r]),
    );

    return rows
      .filter((p) => p.isActive)
      .map((p) => {
        const m = memberships.find((x) => x.propertyId === p.id);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          timezone: p.timezone,
          currencyCode: p.currencyCode,
          countryCode: p.countryCode,
          checkInTime: p.checkInTime,
          checkOutTime: p.checkOutTime,
          taxInclusivePricing: p.taxInclusivePricing,
          addressLine1: p.addressLine1,
          city: p.city,
          organizationId: p.organizationId,
          isActive: p.isActive,
          role: m ? { key: roleById.get(m.roleId)?.key ?? null } : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Updates the caller's ACTIVE property only. The id in the path is checked
   * against the session's active property, so a valid id from another property
   * cannot be edited by tampering with the URL.
   */
  @RequirePermissions('property.update')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePropertyDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const active = req.user!.activePropertyId;
    if (!active || id !== active) {
      // Same response as a property that does not exist, so existence is not leaked.
      return { notFound: true };
    }

    const before = await db.orm.public.Property.where({ id: brand(id) }).first();
    if (!before) return { notFound: true };

    const patch: Record<string, never> = {};
    if (dto.name !== undefined) patch['name'] = brand(dto.name);
    if (dto.timezone !== undefined) patch['timezone'] = brand(dto.timezone);
    if (dto.currencyCode !== undefined) patch['currencyCode'] = brand(dto.currencyCode.toUpperCase());
    if (dto.countryCode !== undefined) patch['countryCode'] = brand(dto.countryCode.toUpperCase());
    if (dto.checkInTime !== undefined) patch['checkInTime'] = brand(dto.checkInTime);
    if (dto.checkOutTime !== undefined) patch['checkOutTime'] = brand(dto.checkOutTime);
    if (dto.taxInclusivePricing !== undefined) patch['taxInclusivePricing'] = brand(dto.taxInclusivePricing);
    if (dto.addressLine1 !== undefined) patch['addressLine1'] = brand(dto.addressLine1);
    if (dto.city !== undefined) patch['city'] = brand(dto.city);

    const updated = await db.orm.public.Property.where({ id: brand(id) }).update(patch);
    if (!updated) return { notFound: true };

    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId: id,
      actorUserId: req.user!.id,
      action: 'property.update',
      resourceType: 'Property',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { changedFields: Object.keys(dto) },
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      timezone: updated.timezone,
      currencyCode: updated.currencyCode,
      countryCode: updated.countryCode,
      checkInTime: updated.checkInTime,
      checkOutTime: updated.checkOutTime,
      taxInclusivePricing: updated.taxInclusivePricing,
      addressLine1: updated.addressLine1,
      city: updated.city,
      isActive: updated.isActive,
    };
  }
}