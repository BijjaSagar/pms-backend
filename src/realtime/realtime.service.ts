import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { EventEmitter } from 'node:events';
import { BOOKING_EVENTS_CHANNEL, type BookingEvent } from '../contracts/booking.messages.js';

/**
 * Fans availability changes out to connected browsers.
 *
 * Subscribes to the booking service's pub/sub channel on a dedicated Redis
 * connection (a subscriber cannot issue normal commands) and re-emits each
 * event locally. The SSE controller filters by property and streams it.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly subscriber: Redis;
  private readonly emitter = new EventEmitter();

  constructor(config: ConfigService) {
    this.subscriber = new Redis({
      host: config.get<string>('redis.host') ?? '127.0.0.1',
      port: config.get<number>('redis.port') ?? 6379,
      maxRetriesPerRequest: 2,
    });
    // One listener per open browser tab; the default ceiling of 10 is too low.
    this.emitter.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        this.emitter.emit('booking', JSON.parse(message) as BookingEvent);
      } catch {
        // A malformed frame is dropped; clients re-fetch availability anyway.
      }
    });
    await this.subscriber.subscribe(BOOKING_EVENTS_CHANNEL);
    this.logger.log('Subscribed to booking availability events (Redis)');
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber.disconnect();
  }

  /** Registers a listener and returns an unsubscribe function. */
  onBooking(listener: (event: BookingEvent) => void): () => void {
    this.emitter.on('booking', listener);
    return () => this.emitter.off('booking', listener);
  }
}
