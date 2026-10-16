import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AuditLogService } from './audit-log.service.js';
import { AuditLogController } from './audit-log.controller.js';

@Global()
@Module({
  controllers: [AuditLogController],
  providers: [AuditService, AuditLogService],
  exports: [AuditService, AuditLogService],
})
export class AuditModule {}