import { Module } from '@nestjs/common';
import { ReportsController, NightAuditController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { NightAuditService } from '../night-audit/night-audit.service.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { AuditLogController } from '../audit/audit-log.controller.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [ReportsController, NightAuditController, AuditLogController],
  providers: [ReportsService, NightAuditService, AuditLogService],
  exports: [ReportsService, NightAuditService, AuditLogService],
})
export class ReportsModule {}