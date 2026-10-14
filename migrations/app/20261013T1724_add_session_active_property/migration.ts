#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/3f7d83ea50e09fae5e7ebe90a63a5b7af5b928f7d302c335d5c2f8bd936f9379/contract';
import endContract from '../../snapshots/3f7d83ea50e09fae5e7ebe90a63a5b7af5b928f7d302c335d5c2f8bd936f9379/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/583c5679be62f15cd67a9765aede06d11c97acfcf2f5ac29a955779397219532/contract';
import startContract from '../../snapshots/583c5679be62f15cd67a9765aede06d11c97acfcf2f5ac29a955779397219532/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Session',
        column: col('activePropertyId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'Session',
        index: 'Session_userId_activePropertyId_idx',
        columns: ['userId', 'activePropertyId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
