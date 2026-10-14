#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/3f7d83ea50e09fae5e7ebe90a63a5b7af5b928f7d302c335d5c2f8bd936f9379/contract';
import startContract from '../../snapshots/3f7d83ea50e09fae5e7ebe90a63a5b7af5b928f7d302c335d5c2f8bd936f9379/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/de94403c016566a3d141c504383e3e2b846dff437b4542ae295052fdfe64bd19/contract';
import endContract from '../../snapshots/de94403c016566a3d141c504383e3e2b846dff437b4542ae295052fdfe64bd19/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Payment',
        column: col('refundedAmount', 'numeric(12,2)', {
          codecRef: { codecId: 'pg/numeric@1', typeParams: { precision: 12, scale: 2 } },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
