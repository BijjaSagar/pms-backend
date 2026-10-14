import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';
import { scrubMetadata } from '../common/pii.js';
import { businessDateOf } from '../common/dates.js';
import { toCsv } from '../reports/csv.js';

/**
 * Read-only audit trail.
 *
 * There is no update or delete path here by design. An audit log that can be
 * edited is not an audit log, so the omission is deliberate rather than a gap
 * to be filled in a later phase.
 */
@Injectable()
export class AuditLogService {
  private async property(req: any) {
    const id = req.user?.activePropertyId;
    if (!id) throw new BadRequestException('Select an active property first');
    return db.orm.public.Property.where({ id: brand(id) }).first();
  }

  async list(req: any, filters: {
    from?: string;
    to?: string;
    actorUserId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: string;
    limit?: number;
  }) {
    const property = await this.property(req);
    if (!property) throw new BadRequestException('Active property not found');

    let rows = await db.orm.public.AuditLog
      .where({ propertyId: brand(property.id) })
      .all();

    // Audit timestamps are DateTime and come back space-separated in UTC, so a
    // raw slice would be a day behind the property's business date and the
    // date filter would silently return the wrong window.
    if (filters.from) {
      rows = rows.filter((r) => businessDateOf(property.timezone, r.createdAt) >= filters.from!);
    }
    if (filters.to) {
      rows = rows.filter((r) => businessDateOf(property.timezone, r.createdAt) <= filters.to!);
    }
    if (filters.actorUserId) rows = rows.filter((r) => r.actorUserId === filters.actorUserId);
    if (filters.action) rows = rows.filter((r) => r.action === filters.action);
    if (filters.resourceType) rows = rows.filter((r) => r.resourceType === filters.resourceType);
    if (filters.resourceId) rows = rows.filter((r) => r.resourceId === filters.resourceId);
    if (filters.outcome) rows = rows.filter((r) => r.outcome === filters.outcome);

    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    const total = rows.length;
    const page = rows
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);

    const actorIds = [...new Set(page.map((r) => r.actorUserId).filter(Boolean))] as string[];
    const users = actorIds.length
      ? await db.orm.public.User.where((m) => m.id.in(actorIds)).all()
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    return {
      total,
      returned: page.length,
      limit,
      // Scoped so a caller cannot read another property's trail.
      rows: page.map((r) => ({
        id: r.id,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        outcome: r.outcome,
        reason: r.reason,
        actorUserId: r.actorUserId,
        actorName: r.actorUserId ? nameById.get(r.actorUserId) ?? null : null,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
        metadata: scrubMetadata(r.metadata),
      })),
    };
  }

  /** Distinct actions recorded for this property, for populating filter menus. */
  async actions(req: any) {
    const property = await this.property(req);
    if (!property) throw new BadRequestException('Active property not found');
    const rows = await db.orm.public.AuditLog
      .where({ propertyId: brand(property.id) })
      .all();
    return [...new Set(rows.map((r) => r.action))].sort();
  }

  /** CSV export. Gated on `audit-log.export` at the controller. */
  async exportCsv(req: any, filters: Parameters<typeof this.list>[1]) {
    const { rows } = await this.list(req, { ...filters, limit: 1000 });
    return toCsv(
      ['createdAt', 'action', 'outcome', 'actor', 'resourceType', 'resourceId', 'reason'],
      rows.map((r) => [
        r.createdAt, r.action, r.outcome, r.actorName ?? 'system',
        r.resourceType, r.resourceId, r.reason,
      ]),
    );
  }
}