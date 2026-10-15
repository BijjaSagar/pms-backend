import { Global, Module } from '@nestjs/common';
import { BookingClientService } from './booking-client.service.js';

/**
 * Global so every reservation, stay and folio controller can inject
 * `BookingClientService` without each feature module importing it.
 */
@Global()
@Module({
  providers: [BookingClientService],
  exports: [BookingClientService],
})
export class BookingClientModule {}
