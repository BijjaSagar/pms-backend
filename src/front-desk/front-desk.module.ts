import { Module } from '@nestjs/common';
import { FrontDeskController } from './front-desk.controller.js';

/**
 * Front-desk, folio and invoice HTTP surface.
 *
 * The logic now lives in the booking microservice; this module contributes only
 * the controller, which reaches it through the global `BookingClientModule`.
 */
@Module({
  controllers: [FrontDeskController],
})
export class FrontDeskModule {}
