import { Injectable, Logger } from '@nestjs/common';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';

/**
 * Fields an audit caller may supply. Credentials, password hashes, reset tokens
 * and session tokens are deliberately absent from this type so they cannot be
 * passed by accident; there is no index signature that would allow extras.
 */
export interface AuditEvent {
  organizationId: string;
  propertyId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE';
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Writes one append-only audit row.
   *
   * Accepts an optional transaction scope so the audit row commits atomically
   * with the state change it describes. AuditLog has no updatedAt column by
   * design: rows are evidence, not editable state.
   */
  async record(event: AuditEvent, tx?: unknown): Promise<void> {
    const client = (tx ?? db) as typeof db;
    try {
      await client.orm.public.AuditLog.create({
        organizationId: brand(event.organizationId),
        propertyId: brand(event.propertyId ?? null),
        actorUserId: brand(event.actorUserId ?? null),
        action: brand(event.action),
        resourceType: brand(event.resourceType),
        resourceId: brand(event.resourceId ?? null),
        outcome: brand(event.outcome ?? 'SUCCESS'),
        reason: brand(event.reason ?? null),
        requestId: brand(event.requestId ?? null),
        ipAddress: brand(event.ipAddress ?? null),
        userAgent: brand(event.userAgent ?? null),
        metadata: brand(event.metadata ?? null),
      });
    } catch (err) {
      // An audit failure must never mask the original outcome, but it must be loud.
      this.logger.error(
        `audit write failed for ${event.action}/${event.resourceType}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}