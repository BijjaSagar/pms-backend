import { Module } from '@nestjs/common';
import { GuestsController } from '../guests/guests.controller.js';
import { GuestsService } from '../guests/guests.service.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

/** Phase 4A: guest directory and the reservation lifecycle. */
@Module({
  controllers: [GuestsController, ReservationsController],
  providers: [GuestsService, ReservationsService],
  exports: [GuestsService, ReservationsService],
})
export class GuestReservationModule {}