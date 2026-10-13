import 'dotenv/config';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { db } from '../prisma/db.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  /** Typed Prisma ORM client (empty contract — no models yet). */
  readonly db = db;

  private pool?: Pool;

  onModuleInit() {
    const url = process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and set it.',
      );
    }
    // Instantiate the Prisma runtime to validate contract wiring at startup.
    // The underlying pg pool connects lazily on first query.
    this.db.runtime();
    this.pool = new Pool({ connectionString: url });
    this.logger.log('Database client initialized');
  }

  async checkConnection(): Promise<{ ok: boolean; latencyMs: number }> {
    if (!this.pool) {
      throw new Error('Database pool is not initialized');
    }
    const start = Date.now();
    await this.pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  }

  async onModuleDestroy() {
    await this.pool?.end().catch(() => undefined);
    await this.db.close().catch(() => undefined);
  }
}
