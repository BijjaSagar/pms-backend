import { Module } from '@nestjs/common';
import { ReportsController, NightAuditController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { NightAuditService } from '../night-audit/night-audit.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [ReportsController, NightAuditController],
  providers: [ReportsService, NightAuditService],
  exports: [ReportsService, NightAuditService],
})
export class ReportsModule {}