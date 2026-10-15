import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RoomHoldService } from './room-hold.service.js';

/**
 * Periodic cleanup of lapsed holds.
 *
 * Purely housekeeping: an expired hold is already invisible to every read and
 * can be reclaimed by the next acquire, so a missed sweep never blocks or frees
 * anything incorrectly. The guard against overlapping runs matters when the
 * sweep is slow; the operation itself is idempotent, so running it on several
 * booking-service instances at once is harmless.
 */
@Injectable()
export class HoldSweepService {
  private readonly logger = new Logger(HoldSweepService.name);
  private running = false;

  constructor(private readonly holds: RoomHoldService) {}

  @Interval(60_000)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.holds.expireSweep();
      if (removed > 0) this.logger.log(`hold sweep removed ${removed} expired row(s)`);
    } catch (err) {
      this.logger.error(`hold sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
