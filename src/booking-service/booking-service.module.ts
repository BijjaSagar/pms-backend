import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ReservationsService } from './reservations.service.js';
import { FrontDeskService } from './front-desk.service.js';
import { FolioService } from './folio.service.js';
import { InvoiceService } from './invoice.service.js';
import { RoomHoldService } from './room-hold.service.js';
import { HoldSweepService } from './hold-sweep.service.js';
import { ReservationMessageController } from './reservation.message-controller.js';
import { FrontDeskMessageController } from './front-desk.message-controller.js';
import { FolioMessageController } from './folio.message-controller.js';

/**
 * The booking microservice.
 *
 * Owns reservations, stays, folios, invoices and the database-backed room
 * holds. It shares the Postgres database and the audit module with the gateway —
 * the split is at the process and transport boundary, not the data boundary.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, AuditModule, ScheduleModule.forRoot()],
  controllers: [ReservationMessageController, FrontDeskMessageController, FolioMessageController],
  providers: [ReservationsService, FrontDeskService, FolioService, InvoiceService, RoomHoldService, HoldSweepService],
})
export class BookingServiceModule {}
