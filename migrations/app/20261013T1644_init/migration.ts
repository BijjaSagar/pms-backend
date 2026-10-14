#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/583c5679be62f15cd67a9765aede06d11c97acfcf2f5ac29a955779397219532/contract';
import endContract from '../../snapshots/583c5679be62f15cd67a9765aede06d11c97acfcf2f5ac29a955779397219532/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations(): ReturnType<Migration<never, End>['operations']> {
    return [
      this.createSchema({ schema: 'public' }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'BookingSource',
        members: ['DIRECT', 'WALK_IN', 'PHONE', 'EMAIL', 'OTA', 'CORPORATE', 'OTHER'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'FolioItemType',
        members: ['ROOM_CHARGE', 'TAX', 'INCIDENTAL', 'FEE', 'DISCOUNT', 'ADJUSTMENT', 'REVERSAL'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'FolioStatus',
        members: ['OPEN', 'CLOSED', 'VOID'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'HousekeepingTaskStatus',
        members: [
          'TODO',
          'IN_PROGRESS',
          'CLEANED',
          'INSPECTION_REQUIRED',
          'READY',
          'BLOCKED',
          'CANCELLED',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'HousekeepingTaskType',
        members: [
          'CHECKOUT_CLEAN',
          'STAYOVER_CLEAN',
          'INSPECTION',
          'TURNDOWN',
          'SPECIAL_REQUEST',
          'LINEN_CHANGE',
          'OTHER',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'InvoiceStatus',
        members: ['DRAFT', 'ISSUED', 'VOID', 'CREDITED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'MaintenanceCategory',
        members: [
          'PLUMBING',
          'ELECTRICAL',
          'HVAC',
          'FURNITURE',
          'APPLIANCE',
          'SAFETY',
          'IT',
          'OTHER',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'MaintenancePriority',
        members: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'MaintenanceStatus',
        members: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'NightAuditStatus',
        members: ['PREVIEWED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'REOPENED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'NotificationType',
        members: [
          'RESERVATION',
          'ARRIVAL',
          'DEPARTURE',
          'HOUSEKEEPING',
          'MAINTENANCE',
          'PAYMENT',
          'NIGHT_AUDIT',
          'SYSTEM',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'OrganizationStatus',
        members: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'PaymentMethod',
        members: [
          'CASH',
          'CARD_TERMINAL',
          'UPI',
          'BANK_TRANSFER',
          'PAYMENT_LINK',
          'CORPORATE_ACCOUNT',
          'OTHER',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'PaymentStatus',
        members: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'ReservationStatus',
        members: ['DRAFT', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'RoomStatus',
        members: [
          'VACANT_CLEAN',
          'VACANT_DIRTY',
          'OCCUPIED_CLEAN',
          'OCCUPIED_DIRTY',
          'INSPECTED',
          'OUT_OF_ORDER',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'TaskPriority',
        members: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'TaxAppliesTo',
        members: ['ROOM', 'INCIDENTAL', 'ALL'],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'ThemeKey',
        members: [
          'MIDNIGHT_NAVY',
          'SKY_BLUE_WHITE',
          'LUXURY_BEIGE_TAUPE',
          'SAGE_GREEN',
          'SOFT_BLUE_SLATE',
          'EUCALYPTUS',
          'OLIVE_CREAM',
          'DUSTY_LAVENDER',
        ],
      }),
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'UserStatus',
        members: ['INVITED', 'ACTIVE', 'DISABLED'],
      }),
      this.createTable({
        schema: 'public',
        table: 'AuditLog',
        columns: [
          col('action', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('actorUserId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('afterData', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('beforeData', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ipAddress', 'character varying(64)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 64 } },
          }),
          col('metadata', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('organizationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('outcome', 'character varying(30)', {
            notNull: true,
            default: lit('SUCCESS'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 30 } },
          }),
          col('propertyId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requestId', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('resourceId', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('resourceType', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('userAgent', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Folio',
        columns: [
          col('closedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            default: lit('INR'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('folioNo', 'character varying(50)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 50 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('openedAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"FolioStatus"', {
            notNull: true,
            default: lit('OPEN'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'FolioStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'FolioItem',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('description', 'character varying(300)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 300 } },
          }),
          col('folioId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotencyKey', 'character varying(120)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('isVoided', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('postedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('quantity', 'numeric(10,2)', {
            notNull: true,
            default: lit('1'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 10, scale: 2 } },
          }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('taxAmount', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('taxSnapshot', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('totalAmount', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('type', '"FolioItemType"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'FolioItemType' } },
          }),
          col('unitAmount', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('voidedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Guest',
        columns: [
          col('addressLine1', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('addressLine2', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('city', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('companyName', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('countryCode', 'character varying(2)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 2 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('email', 'character varying(320)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 320 } },
          }),
          col('firstName', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('internalNotes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('lastName', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('organizationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('phone', 'character varying(40)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 40 } },
          }),
          col('postalCode', 'character varying(30)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 30 } },
          }),
          col('preferences', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('region', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'HousekeepingTask',
        columns: [
          col('assignedToId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('blockedReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('completedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('dueAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('inspectedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('priority', '"TaskPriority"', {
            notNull: true,
            default: lit('NORMAL'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'TaskPriority' } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('startedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('status', '"HousekeepingTaskStatus"', {
            notNull: true,
            default: lit('TODO'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'HousekeepingTaskStatus' } },
          }),
          col('type', '"HousekeepingTaskType"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'HousekeepingTaskType' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Invoice',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('folioId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('invoiceNo', 'character varying(60)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 60 } },
          }),
          col('issuedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"InvoiceStatus"', {
            notNull: true,
            default: lit('DRAFT'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'InvoiceStatus' } },
          }),
          col('subtotal', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('taxTotal', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('totalAmount', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('voidReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('voidedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'MaintenanceTicket',
        columns: [
          col('assignedToId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('category', '"MaintenanceCategory"', {
            notNull: true,
            default: lit('OTHER'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'MaintenanceCategory' } },
          }),
          col('closedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('description', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('priority', '"MaintenancePriority"', {
            notNull: true,
            default: lit('NORMAL'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'MaintenancePriority' } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reportedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('resolution', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resolvedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('roomId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"MaintenanceStatus"', {
            notNull: true,
            default: lit('OPEN'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'MaintenanceStatus' } },
          }),
          col('ticketNo', 'character varying(50)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 50 } },
          }),
          col('title', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'NightAudit',
        columns: [
          col('businessDate', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('completedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('completedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('exceptionSummary', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('finalSummary', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotencyKey', 'character varying(120)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('previewSummary', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reopenReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reopenedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('startedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('startedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"NightAuditStatus"', {
            notNull: true,
            default: lit('PREVIEWED'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'NightAuditStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Notification',
        columns: [
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('readAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('targetPath', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
          col('title', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('type', '"NotificationType"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'NotificationType' } },
          }),
          col('userId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Organization',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('slug', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('status', '"OrganizationStatus"', {
            notNull: true,
            default: lit('ACTIVE'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'OrganizationStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Payment',
        columns: [
          col('amount', 'numeric(12,2)', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('folioId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idempotencyKey', 'character varying(120)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('method', '"PaymentMethod"', {
            notNull: true,
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'PaymentMethod' } },
          }),
          col('provider', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('receivedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('recordedAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('reference', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('refundedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('settledAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('status', '"PaymentStatus"', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'PaymentStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Permission',
        columns: [
          col('action', 'character varying(80)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 80 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('description', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('key', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('resource', 'character varying(80)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 80 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Property',
        columns: [
          col('addressLine1', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('addressLine2', 'character varying(200)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('checkInTime', 'character varying(5)', {
            notNull: true,
            default: lit('14:00'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 5 } },
          }),
          col('checkOutTime', 'character varying(5)', {
            notNull: true,
            default: lit('11:00'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 5 } },
          }),
          col('city', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('countryCode', 'character varying(2)', {
            notNull: true,
            default: lit('IN'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 2 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            default: lit('INR'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('name', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('organizationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('postalCode', 'character varying(30)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 30 } },
          }),
          col('region', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('slug', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('taxInclusivePricing', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('timezone', 'character varying(100)', {
            notNull: true,
            default: lit('Asia/Kolkata'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'PropertyMembership',
        columns: [
          col('acceptedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('invitedAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roleId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('userId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'RatePlan',
        columns: [
          col('cancellationPolicy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('code', 'character varying(40)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 40 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            default: lit('INR'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('defaultNightlyRate', 'numeric(12,2)', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('isRefundable', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('minStayNights', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('name', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomTypeId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'RatePlanPrice',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('minimumStayNights', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('nightlyRate', 'numeric(12,2)', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('ratePlanId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('stayDate', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('stopSell', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Reservation',
        columns: [
          col('adults', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('bookingCode', 'character varying(40)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 40 } },
          }),
          col('cancellationReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('cancelledAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('checkInDate', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('checkOutDate', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
          col('checkedInAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('checkedOutAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('children', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('createdById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('currencyCode', 'character varying(3)', {
            notNull: true,
            default: lit('INR'),
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('primaryGuestId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('source', '"BookingSource"', {
            notNull: true,
            default: lit('DIRECT'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'BookingSource' } },
          }),
          col('specialRequests', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', '"ReservationStatus"', {
            notNull: true,
            default: lit('DRAFT'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'ReservationStatus' } },
          }),
          col('subtotal', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('taxTotal', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('totalAmount', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'ReservationRoom',
        columns: [
          col('adults', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('children', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('nightlyRate', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('ratePlanId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('ratePlanName', 'character varying(120)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('reservationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomTypeId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Role',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('description', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('isSystem', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('key', 'character varying(60)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 60 } },
          }),
          col('name', 'character varying(100)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('organizationId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'RolePermission',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('permissionId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roleId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['roleId', 'permissionId'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Room',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('floor', 'character varying(30)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 30 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomNumber', 'character varying(30)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 30 } },
          }),
          col('roomTypeId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', '"RoomStatus"', {
            notNull: true,
            default: lit('VACANT_DIRTY'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'RoomStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('wing', 'character varying(50)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 50 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'RoomNightInventory',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('reservationRoomId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('roomId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('stayDate', 'date', { notNull: true, codecRef: { codecId: 'pg/date-string@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'RoomType',
        columns: [
          col('amenities', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('baseOccupancy', 'int4', {
            notNull: true,
            default: lit(2),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('baseRate', 'numeric(12,2)', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
          }),
          col('code', 'character varying(40)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 40 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('maxAdults', 'int4', {
            notNull: true,
            default: lit(2),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('maxChildren', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('name', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Session',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('expiresAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ipAddress', 'character varying(64)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 64 } },
          }),
          col('lastSeenAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('revokedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('tokenHash', 'character varying(255)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('userAgent', 'character varying(500)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 500 } },
          }),
          col('userId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'TaxRule',
        columns: [
          col('appliesTo', '"TaxAppliesTo"', {
            notNull: true,
            default: lit('ALL'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'TaxAppliesTo' } },
          }),
          col('code', 'character varying(40)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 40 } },
          }),
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('isCompound', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('isInclusive', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('name', 'character varying(120)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
          }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ratePercent', 'numeric(7,4)', {
            notNull: true,
            codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 7, scale: 4 } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('validFrom', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
          col('validTo', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'User',
        columns: [
          col('createdAt', 'timestamp(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('email', 'character varying(320)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 320 } },
          }),
          col('emailVerifiedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('fullName', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('lastLoginAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('passwordChangedAt', 'timestamp(3)', {
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('passwordHash', 'character varying(255)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 255 } },
          }),
          col('status', '"UserStatus"', {
            notNull: true,
            default: lit('INVITED'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'UserStatus' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'UserThemePreference',
        columns: [
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('propertyId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('themeKey', '"ThemeKey"', {
            notNull: true,
            default: lit('LUXURY_BEIGE_TAUPE'),
            codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'ThemeKey' } },
          }),
          col('updatedAt', 'timestamp(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
          }),
          col('userId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditLog',
        index: 'AuditLog_action_createdAt_idx',
        columns: ['action', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditLog',
        index: 'AuditLog_actorUserId_createdAt_idx',
        columns: ['actorUserId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditLog',
        index: 'AuditLog_organizationId_createdAt_idx',
        columns: ['organizationId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditLog',
        index: 'AuditLog_propertyId_createdAt_idx',
        columns: ['propertyId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'AuditLog',
        index: 'AuditLog_resourceType_resourceId_idx',
        columns: ['resourceType', 'resourceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Folio',
        index: 'Folio_propertyId_folioNo_key',
        columns: ['propertyId', 'folioNo'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Folio',
        index: 'Folio_propertyId_status_openedAt_idx',
        columns: ['propertyId', 'status', 'openedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Folio',
        index: 'Folio_reservationId_idx',
        columns: ['reservationId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'FolioItem',
        index: 'FolioItem_folioId_createdAt_idx',
        columns: ['folioId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'FolioItem',
        index: 'FolioItem_idempotencyKey_key',
        columns: ['idempotencyKey'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'FolioItem',
        index: 'FolioItem_postedById_createdAt_idx',
        columns: ['postedById', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Guest',
        index: 'Guest_organizationId_email_idx',
        columns: ['organizationId', 'email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Guest',
        index: 'Guest_organizationId_lastName_firstName_idx',
        columns: ['organizationId', 'lastName', 'firstName'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Guest',
        index: 'Guest_organizationId_phone_idx',
        columns: ['organizationId', 'phone'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'HousekeepingTask',
        index: 'HousekeepingTask_assignedToId_status_dueAt_idx',
        columns: ['assignedToId', 'status', 'dueAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'HousekeepingTask',
        index: 'HousekeepingTask_propertyId_status_dueAt_idx',
        columns: ['propertyId', 'status', 'dueAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'HousekeepingTask',
        index: 'HousekeepingTask_roomId_createdAt_idx',
        columns: ['roomId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Invoice',
        index: 'Invoice_folioId_idx',
        columns: ['folioId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Invoice',
        index: 'Invoice_propertyId_invoiceNo_key',
        columns: ['propertyId', 'invoiceNo'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Invoice',
        index: 'Invoice_propertyId_status_issuedAt_idx',
        columns: ['propertyId', 'status', 'issuedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'MaintenanceTicket',
        index: 'MaintenanceTicket_assignedToId_status_idx',
        columns: ['assignedToId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'MaintenanceTicket',
        index: 'MaintenanceTicket_propertyId_status_priority_idx',
        columns: ['propertyId', 'status', 'priority'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'MaintenanceTicket',
        index: 'MaintenanceTicket_propertyId_ticketNo_key',
        columns: ['propertyId', 'ticketNo'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'MaintenanceTicket',
        index: 'MaintenanceTicket_roomId_createdAt_idx',
        columns: ['roomId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'NightAudit',
        index: 'NightAudit_idempotencyKey_key',
        columns: ['idempotencyKey'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'NightAudit',
        index: 'NightAudit_propertyId_businessDate_key',
        columns: ['propertyId', 'businessDate'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'NightAudit',
        index: 'NightAudit_propertyId_status_businessDate_idx',
        columns: ['propertyId', 'status', 'businessDate'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Notification',
        index: 'Notification_propertyId_type_createdAt_idx',
        columns: ['propertyId', 'type', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Notification',
        index: 'Notification_userId_readAt_createdAt_idx',
        columns: ['userId', 'readAt', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Organization',
        index: 'Organization_slug_key',
        columns: ['slug'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Organization',
        index: 'Organization_status_idx',
        columns: ['status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Payment',
        index: 'Payment_folioId_status_recordedAt_idx',
        columns: ['folioId', 'status', 'recordedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Payment',
        index: 'Payment_idempotencyKey_key',
        columns: ['idempotencyKey'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Payment',
        index: 'Payment_provider_reference_idx',
        columns: ['provider', 'reference'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Permission',
        index: 'Permission_key_key',
        columns: ['key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Permission',
        index: 'Permission_resource_action_idx',
        columns: ['resource', 'action'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Property',
        index: 'Property_organizationId_isActive_idx',
        columns: ['organizationId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Property',
        index: 'Property_organizationId_slug_key',
        columns: ['organizationId', 'slug'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'PropertyMembership',
        index: 'PropertyMembership_propertyId_isActive_idx',
        columns: ['propertyId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PropertyMembership',
        index: 'PropertyMembership_roleId_isActive_idx',
        columns: ['roleId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PropertyMembership',
        index: 'PropertyMembership_userId_propertyId_key',
        columns: ['userId', 'propertyId'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RatePlan',
        index: 'RatePlan_propertyId_code_key',
        columns: ['propertyId', 'code'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RatePlan',
        index: 'RatePlan_propertyId_isActive_idx',
        columns: ['propertyId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'RatePlanPrice',
        index: 'RatePlanPrice_ratePlanId_stayDate_key',
        columns: ['ratePlanId', 'stayDate'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RatePlanPrice',
        index: 'RatePlanPrice_stayDate_stopSell_idx',
        columns: ['stayDate', 'stopSell'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Reservation',
        index: 'Reservation_primaryGuestId_createdAt_idx',
        columns: ['primaryGuestId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Reservation',
        index: 'Reservation_propertyId_bookingCode_key',
        columns: ['propertyId', 'bookingCode'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Reservation',
        index: 'Reservation_propertyId_checkOutDate_idx',
        columns: ['propertyId', 'checkOutDate'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Reservation',
        index: 'Reservation_propertyId_status_checkInDate_idx',
        columns: ['propertyId', 'status', 'checkInDate'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ReservationRoom',
        index: 'ReservationRoom_ratePlanId_idx',
        columns: ['ratePlanId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ReservationRoom',
        index: 'ReservationRoom_reservationId_idx',
        columns: ['reservationId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ReservationRoom',
        index: 'ReservationRoom_roomTypeId_roomId_idx',
        columns: ['roomTypeId', 'roomId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Role',
        index: 'Role_organizationId_isActive_idx',
        columns: ['organizationId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Role',
        index: 'Role_organizationId_key_key',
        columns: ['organizationId', 'key'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RolePermission',
        index: 'RolePermission_permissionId_idx',
        columns: ['permissionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Room',
        index: 'Room_propertyId_roomNumber_key',
        columns: ['propertyId', 'roomNumber'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Room',
        index: 'Room_propertyId_status_isActive_idx',
        columns: ['propertyId', 'status', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Room',
        index: 'Room_roomTypeId_isActive_idx',
        columns: ['roomTypeId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomNightInventory',
        index: 'RoomNightInventory_reservationRoomId_stayDate_key',
        columns: ['reservationRoomId', 'stayDate'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomNightInventory',
        index: 'RoomNightInventory_roomId_stayDate_key',
        columns: ['roomId', 'stayDate'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomNightInventory',
        index: 'RoomNightInventory_stayDate_idx',
        columns: ['stayDate'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomType',
        index: 'RoomType_propertyId_code_key',
        columns: ['propertyId', 'code'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomType',
        index: 'RoomType_propertyId_isActive_idx',
        columns: ['propertyId', 'isActive'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Session',
        index: 'Session_revokedAt_expiresAt_idx',
        columns: ['revokedAt', 'expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'Session',
        index: 'Session_tokenHash_key',
        columns: ['tokenHash'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'Session',
        index: 'Session_userId_expiresAt_idx',
        columns: ['userId', 'expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'TaxRule',
        index: 'TaxRule_propertyId_code_key',
        columns: ['propertyId', 'code'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'TaxRule',
        index: 'TaxRule_propertyId_isActive_validFrom_validTo_idx',
        columns: ['propertyId', 'isActive', 'validFrom', 'validTo'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'User',
        index: 'User_email_key',
        columns: ['email'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'User',
        index: 'User_status_lastLoginAt_idx',
        columns: ['status', 'lastLoginAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserThemePreference',
        index: 'UserThemePreference_propertyId_themeKey_idx',
        columns: ['propertyId', 'themeKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'UserThemePreference',
        index: 'UserThemePreference_userId_propertyId_key',
        columns: ['userId', 'propertyId'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AuditLog',
        foreignKey: {
          name: 'AuditLog_organizationId_fkey',
          columns: ['organizationId'],
          references: { schema: 'public', table: 'Organization', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AuditLog',
        foreignKey: {
          name: 'AuditLog_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'AuditLog',
        foreignKey: {
          name: 'AuditLog_actorUserId_fkey',
          columns: ['actorUserId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Folio',
        foreignKey: {
          name: 'Folio_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Folio',
        foreignKey: {
          name: 'Folio_reservationId_fkey',
          columns: ['reservationId'],
          references: { schema: 'public', table: 'Reservation', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'FolioItem',
        foreignKey: {
          name: 'FolioItem_folioId_fkey',
          columns: ['folioId'],
          references: { schema: 'public', table: 'Folio', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'FolioItem',
        foreignKey: {
          name: 'FolioItem_postedById_fkey',
          columns: ['postedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Guest',
        foreignKey: {
          name: 'Guest_organizationId_fkey',
          columns: ['organizationId'],
          references: { schema: 'public', table: 'Organization', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'HousekeepingTask',
        foreignKey: {
          name: 'HousekeepingTask_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'HousekeepingTask',
        foreignKey: {
          name: 'HousekeepingTask_roomId_fkey',
          columns: ['roomId'],
          references: { schema: 'public', table: 'Room', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'HousekeepingTask',
        foreignKey: {
          name: 'HousekeepingTask_assignedToId_fkey',
          columns: ['assignedToId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'HousekeepingTask',
        foreignKey: {
          name: 'HousekeepingTask_createdById_fkey',
          columns: ['createdById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Invoice',
        foreignKey: {
          name: 'Invoice_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Invoice',
        foreignKey: {
          name: 'Invoice_folioId_fkey',
          columns: ['folioId'],
          references: { schema: 'public', table: 'Folio', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'MaintenanceTicket',
        foreignKey: {
          name: 'MaintenanceTicket_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'MaintenanceTicket',
        foreignKey: {
          name: 'MaintenanceTicket_roomId_fkey',
          columns: ['roomId'],
          references: { schema: 'public', table: 'Room', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'MaintenanceTicket',
        foreignKey: {
          name: 'MaintenanceTicket_reportedById_fkey',
          columns: ['reportedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'MaintenanceTicket',
        foreignKey: {
          name: 'MaintenanceTicket_assignedToId_fkey',
          columns: ['assignedToId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'NightAudit',
        foreignKey: {
          name: 'NightAudit_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'NightAudit',
        foreignKey: {
          name: 'NightAudit_startedById_fkey',
          columns: ['startedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'NightAudit',
        foreignKey: {
          name: 'NightAudit_completedById_fkey',
          columns: ['completedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Notification',
        foreignKey: {
          name: 'Notification_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Notification',
        foreignKey: {
          name: 'Notification_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Payment',
        foreignKey: {
          name: 'Payment_folioId_fkey',
          columns: ['folioId'],
          references: { schema: 'public', table: 'Folio', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Payment',
        foreignKey: {
          name: 'Payment_receivedById_fkey',
          columns: ['receivedById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Property',
        foreignKey: {
          name: 'Property_organizationId_fkey',
          columns: ['organizationId'],
          references: { schema: 'public', table: 'Organization', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PropertyMembership',
        foreignKey: {
          name: 'PropertyMembership_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PropertyMembership',
        foreignKey: {
          name: 'PropertyMembership_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PropertyMembership',
        foreignKey: {
          name: 'PropertyMembership_roleId_fkey',
          columns: ['roleId'],
          references: { schema: 'public', table: 'Role', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RatePlan',
        foreignKey: {
          name: 'RatePlan_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RatePlan',
        foreignKey: {
          name: 'RatePlan_roomTypeId_fkey',
          columns: ['roomTypeId'],
          references: { schema: 'public', table: 'RoomType', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RatePlanPrice',
        foreignKey: {
          name: 'RatePlanPrice_ratePlanId_fkey',
          columns: ['ratePlanId'],
          references: { schema: 'public', table: 'RatePlan', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Reservation',
        foreignKey: {
          name: 'Reservation_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Reservation',
        foreignKey: {
          name: 'Reservation_primaryGuestId_fkey',
          columns: ['primaryGuestId'],
          references: { schema: 'public', table: 'Guest', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Reservation',
        foreignKey: {
          name: 'Reservation_createdById_fkey',
          columns: ['createdById'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ReservationRoom',
        foreignKey: {
          name: 'ReservationRoom_reservationId_fkey',
          columns: ['reservationId'],
          references: { schema: 'public', table: 'Reservation', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ReservationRoom',
        foreignKey: {
          name: 'ReservationRoom_roomTypeId_fkey',
          columns: ['roomTypeId'],
          references: { schema: 'public', table: 'RoomType', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ReservationRoom',
        foreignKey: {
          name: 'ReservationRoom_roomId_fkey',
          columns: ['roomId'],
          references: { schema: 'public', table: 'Room', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ReservationRoom',
        foreignKey: {
          name: 'ReservationRoom_ratePlanId_fkey',
          columns: ['ratePlanId'],
          references: { schema: 'public', table: 'RatePlan', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Role',
        foreignKey: {
          name: 'Role_organizationId_fkey',
          columns: ['organizationId'],
          references: { schema: 'public', table: 'Organization', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RolePermission',
        foreignKey: {
          name: 'RolePermission_roleId_fkey',
          columns: ['roleId'],
          references: { schema: 'public', table: 'Role', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RolePermission',
        foreignKey: {
          name: 'RolePermission_permissionId_fkey',
          columns: ['permissionId'],
          references: { schema: 'public', table: 'Permission', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Room',
        foreignKey: {
          name: 'Room_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Room',
        foreignKey: {
          name: 'Room_roomTypeId_fkey',
          columns: ['roomTypeId'],
          references: { schema: 'public', table: 'RoomType', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RoomNightInventory',
        foreignKey: {
          name: 'RoomNightInventory_roomId_fkey',
          columns: ['roomId'],
          references: { schema: 'public', table: 'Room', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RoomNightInventory',
        foreignKey: {
          name: 'RoomNightInventory_reservationRoomId_fkey',
          columns: ['reservationRoomId'],
          references: { schema: 'public', table: 'ReservationRoom', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'RoomType',
        foreignKey: {
          name: 'RoomType_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'Session',
        foreignKey: {
          name: 'Session_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'TaxRule',
        foreignKey: {
          name: 'TaxRule_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserThemePreference',
        foreignKey: {
          name: 'UserThemePreference_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'User', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'UserThemePreference',
        foreignKey: {
          name: 'UserThemePreference_propertyId_fkey',
          columns: ['propertyId'],
          references: { schema: 'public', table: 'Property', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
