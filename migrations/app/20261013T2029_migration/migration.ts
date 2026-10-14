#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/de94403c016566a3d141c504383e3e2b846dff437b4542ae295052fdfe64bd19/contract';
import startContract from '../../snapshots/de94403c016566a3d141c504383e3e2b846dff437b4542ae295052fdfe64bd19/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f062fa703dde8284abddd2faf2297c4526f3076b0292525272cf5bada03f8728/contract';
import endContract from '../../snapshots/f062fa703dde8284abddd2faf2297c4526f3076b0292525272cf5bada03f8728/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('inviteExpiresAt', 'timestamp(3)', {
          codecRef: { codecId: 'pg/timestamp-string@1', typeParams: { precision: 3 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'User',
        column: col('inviteToken', 'character varying(120)', {
          codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 120 } },
        }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'User',
        index: 'User_inviteToken_key',
        columns: ['inviteToken'],
        extras: { unique: true },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
