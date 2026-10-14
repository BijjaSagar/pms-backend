import { Module } from '@nestjs/common';
import { HousekeepingController } from './housekeeping.controller.js';
import { HousekeepingService } from './housekeeping.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * Housekeeping and maintenance.
 *
 * These share a controller because they share the floor: a room goes out of
 * service through a maintenance decision, and the task that cleans it up comes
 * from the same place a housekeeper is already looking.
 */
@Module({
  imports: [AuditModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService, MaintenanceService],
  exports: [HousekeepingService, MaintenanceService],
})
export class HousekeepingModule {}