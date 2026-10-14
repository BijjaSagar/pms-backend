import { Module } from '@nestjs/common';
import { FrontDeskController } from './front-desk.controller.js';
import { FrontDeskService } from './front-desk.service.js';
import { FolioService } from '../folios/folio.service.js';
import { InvoiceService } from '../folios/invoice.service.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * The arrival-to-departure workflow plus the money it produces. Phases 5A and 6A.
 *
 * AuditModule is imported explicitly because FolioService now writes audit rows
 * for void, close, reopen and refund. Those actions each move or forgive money,
 * so the record of who did it is not optional.
 */
@Module({
  imports: [AuditModule],
  controllers: [FrontDeskController],
  providers: [FrontDeskService, FolioService, InvoiceService],
  exports: [FrontDeskService, FolioService, InvoiceService],
})
export class FrontDeskModule {}