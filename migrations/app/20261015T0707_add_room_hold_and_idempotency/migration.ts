#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/79388c46b023b73ce5279e12714a73f3df2806bf611ff77f96e10cd15372b2d1/contract';
import endContract from '../../snapshots/79388c46b023b73ce5279e12714a73f3df2806bf611ff77f96e10cd15372b2d1/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f062fa703dde8284abddd2faf2297c4526f3076b0292525272cf5bada03f8728/contract';
import startContract from '../../snapshots/f062fa703dde8284abddd2faf2297c4526f3076b0292525272cf5bada03f8728/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Reservation',
        column: col('idempotencyKey', 'character varying(120)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'RoomNightInventory',
        column: col('holdExpiresAt', 'timestamp(3)', {
          codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'RoomNightInventory',
        column: col('holdToken', 'character varying(120)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'RoomNightInventory',
        column: col('holdUserId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.dropNotNull({
        schema: 'public',
        table: 'RoomNightInventory',
        column: 'reservationRoomId',
      }),
      this.createIndex({
        schema: 'public',
        table: 'Reservation',
        index: 'Reservation_idempotencyKey_key',
        columns: ['idempotencyKey'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'RoomNightInventory',
        index: 'RoomNightInventory_holdExpiresAt_idx',
        columns: ['holdExpiresAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
