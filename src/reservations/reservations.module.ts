import { Module } from '@nestjs/common';
import { GuestsController } from '../guests/guests.controller.js';
import { GuestsService } from '../guests/guests.service.js';
import { ReservationsController } from './reservations.controller.js';

/**
 * Guest directory and the reservation HTTP surface.
 *
 * The guest directory stays local (it is a shared reference, not booking state);
 * reservations forward to the booking microservice through `BookingClientModule`.
 */
@Module({
  controllers: [GuestsController, ReservationsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestReservationModule {}
