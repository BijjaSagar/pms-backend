import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { Redis } from 'ioredis';

/**
 * Distributed rate limiter storage using Redis.
 *
 * Ensures rate limits (e.g., login attempts, global request ceilings) apply
 * collectively across multiple gateway / auth service instances.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private client: Redis | null = null;
  private readonly localFallback = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('redis.host') ?? process.env['REDIS_HOST'] ?? '127.0.0.1';
    const port = this.config.get<number>('redis.port') ?? parseInt(process.env['REDIS_PORT'] ?? '6379', 10);

    try {
      this.client = new Redis({
        host,
        port,
        maxRetriesPerRequest: 1,
        lazyConnect: false,
      });

      this.client.on('error', (err) => {
        this.logger.warn(`RedisThrottlerStorage connection warning: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`Could not initialize Redis client for throttler: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => this.client?.disconnect());
      this.client = null;
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.client && this.client.status !== 'end' && this.client.status !== 'close') {
      try {
        return await this.incrementRedis(key, ttl, limit, blockDuration, throttlerName);
      } catch (err) {
        this.logger.warn(`Redis rate limit increment failed, falling back to memory: ${(err as Error).message}`);
      }
    }
    return this.incrementLocal(key, ttl, limit, throttlerName);
  }

  private async incrementRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redis = this.client!;
    const redisKey = `pms:throttle:${throttlerName}:${key}`;
    const blockKey = `pms:throttle:block:${throttlerName}:${key}`;

    if (blockDuration > 0) {
      const blockTtl = await redis.pttl(blockKey);
      if (blockTtl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: 0,
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockTtl / 1000),
        };
      }
    }

    const multi = redis.multi();
    multi.incr(redisKey);
    multi.pttl(redisKey);
    const results = await multi.exec();

    if (!results || results.length < 2) {
      throw new Error('Redis multi failed');
    }

    const totalHits = (results[0][1] as number) ?? 1;
    let timeToExpire = (results[1][1] as number) ?? -1;

    if (totalHits === 1 || timeToExpire < 0) {
      await redis.pexpire(redisKey, ttl);
      timeToExpire = ttl;
    }

    let isBlocked = totalHits > limit;
    let timeToBlockExpire = 0;

    if (isBlocked && blockDuration > 0) {
      await redis.pexpire(blockKey, blockDuration);
      timeToBlockExpire = Math.ceil(blockDuration / 1000);
    }

    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(timeToExpire / 1000)),
      isBlocked,
      timeToBlockExpire,
    };
  }

  private incrementLocal(
    key: string,
    ttl: number,
    limit: number,
    throttlerName: string,
  ): ThrottlerStorageRecord {
    const fullKey = `${throttlerName}:${key}`;
    const now = Date.now();
    const entry = this.localFallback.get(fullKey);

    if (!entry || entry.expiresAt <= now) {
      this.localFallback.set(fullKey, { count: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: 1 > limit,
        timeToBlockExpire: 0,
      };
    }

    entry.count += 1;
    const timeToExpire = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
    return {
      totalHits: entry.count,
      timeToExpire,
      isBlocked: entry.count > limit,
      timeToBlockExpire: 0,
    };
  }
}
