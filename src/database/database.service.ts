import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { db } from '../prisma/db.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  /** Typed Prisma ORM client from the emitted contract. */
  readonly prisma = db;

  async onModuleInit() {
    const url = process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and set it.',
      );
    }
    this.logger.log('Database client initialized');
  }

  async checkConnection(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    await db.runtime();
    return { ok: true, latencyMs: Date.now() - start };
  }

  async onModuleDestroy() {
    // Prisma 8 contract client manages its own connection pool
  }
}
