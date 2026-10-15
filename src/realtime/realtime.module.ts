import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service.js';
import { AvailabilityStreamController } from './availability-stream.controller.js';

/**
 * Live availability push. Global so the stream controller and any future
 * consumer share one Redis subscriber connection.
 */
@Global()
@Module({
  controllers: [AvailabilityStreamController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
