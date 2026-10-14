import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { maskEmail as piiMaskEmail, maskPhone as piiMaskPhone } from '../common/pii.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

export interface GuestListItem {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  masked: boolean;
}

const maskEmail = piiMaskEmail;
const maskPhone = piiMaskPhone;

@Injectable()
export class GuestsService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Shifts PII to `null`/`***` when the caller lacks `guest.pii.read`.
   *
   * This is the shape-control boundary: the row is still returned, so counts and
   * list structure stay consistent, but the sensitive fields never leave the
   * server. The Auditor role is the case that matters, since it holds
   * `guest.read` without `guest.pii.read`.
   */
  private shape(row: any, canSeePii: boolean) {
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: canSeePii ? row.email : maskEmail(row.email),
      phone: canSeePii ? row.phone : maskPhone(row.phone),
      companyName: canSeePii ? row.companyName : null,
      addressLine1: canSeePii ? row.addressLine1 : null,
      city: row.city,
      countryCode: canSeePii ? row.countryCode : null,
      masked: !canSeePii,
    };
  }

  private canSeePii(req: AuthenticatedRequest): boolean {
    return (req.user?.permissions ?? []).includes('guest.pii.read');
  }

  /**
   * Guest search.
   *
   * Guests are organization-scoped rather than property-scoped so a group can
   * recognise a repeat guest across its properties, which the kit calls for.
   * Pagination returns `hasMore` rather than a total: the contract client has
   * no standalone count(), and a total would mean reading the whole table.
   */
  async list(
    req: AuthenticatedRequest,
    opts: { search?: string; page: number; pageSize: number },
  ) {
    const organizationId = req.user!.organizationId;
    const take = Math.min(Math.max(opts.pageSize, 1), 100);
    const skip = Math.max(opts.page, 1) - 1;

    const rows = await db.orm.public.Guest
      .where({ organizationId: brand(organizationId) })
      .limit(take + 1)
      .offset(skip * take)
      .all();

    let items = rows;
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = rows.filter(
        (g) =>
          `${g.firstName} ${g.lastName}`.toLowerCase().includes(q) ||
          (g.email ?? '').toLowerCase().includes(q) ||
          (g.phone ?? '').includes(q),
      );
    }

    const canSeePii = this.canSeePii(req);
    return {
      data: items.map((g) => this.shape(g, canSeePii)),
      page: opts.page,
      pageSize: take,
      hasMore: rows.length > take,
    };
  }

  async get(req: AuthenticatedRequest, id: string) {
    const guest = await db.orm.public.Guest
      .where({ id: brand(id), organizationId: brand(req.user!.organizationId) })
      .first();
    // Scoped lookup: an id from another organization is indistinguishable from
    // one that does not exist.
    if (!guest) throw new NotFoundException('Guest not found');

    const canSeePii = this.canSeePii(req);
    const reservations = await db.orm.public.Reservation
      .where({ primaryGuestId: brand(id) })
      .all();

    return {
      ...this.shape(guest, canSeePii),
      preferences: canSeePii ? guest.preferences : null,
      internalNotes: canSeePii ? guest.internalNotes : null,
      masked: !canSeePii,
      stayCount: reservations.length,
      lastStayAt:
        reservations.length > 0
          ? reservations.map((r) => r.createdAt).sort().slice(-1)[0]
          : null,
    };
  }

  async create(req: AuthenticatedRequest, body: any) {
    if (!body.firstName || !body.lastName) {
      throw new BadRequestException('First name and last name are required');
    }
    const created = await db.orm.public.Guest.create({
      organizationId: brand(req.user!.organizationId),
      firstName: brand(body.firstName.trim()),
      lastName: brand(body.lastName.trim()),
      email: brand(body.email?.trim() || null),
      phone: brand(body.phone?.trim() || null),
      companyName: brand(body.companyName?.trim() || null),
      city: brand(body.city?.trim() || null),
      countryCode: brand(body.countryCode?.trim().toUpperCase() || null),
      preferences: brand(body.preferences ?? null),
      internalNotes: brand(body.internalNotes ?? null),
    });

    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId: req.user!.activePropertyId,
      actorUserId: req.user!.id,
      action: 'guest.create',
      resourceType: 'Guest',
      resourceId: created.id,
      outcome: 'SUCCESS',
    });

    return this.shape(created, this.canSeePii(req));
  }

  async update(req: AuthenticatedRequest, id: string, body: any) {
    const existing = await db.orm.public.Guest
      .where({ id: brand(id), organizationId: brand(req.user!.organizationId) })
      .first();
    if (!existing) throw new NotFoundException('Guest not found');

    const allowed = [
      'firstName', 'lastName', 'email', 'phone',
      'companyName', 'addressLine1', 'addressLine2',
      'city', 'region', 'postalCode', 'countryCode',
      'preferences', 'internalNotes',
    ] as const;
    const patch: Record<string, never> = {};
    const changed: string[] = [];
    for (const field of allowed) {
      if (body[field] !== undefined) {
        patch[field] = brand(body[field]);
        changed.push(field);
      }
    }

    const updated = await db.orm.public.Guest.where({ id: brand(id) }).update(patch);
    if (!updated) throw new NotFoundException('Guest not found');

    await this.audit.record({
      organizationId: req.user!.organizationId,
      actorUserId: req.user!.id,
      action: 'guest.update',
      resourceType: 'Guest',
      resourceId: id,
      outcome: 'SUCCESS',
      // Field names only. Values may contain PII and must not enter the log.
      metadata: { changedFields: changed },
    });

    return this.shape(updated, this.canSeePii(req));
  }
}