import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { TaxRulesService } from './tax-rules.service.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * Staff, roles and system settings.
 *
 * The staff and role logic now lives in the auth microservice and is reached
 * through the global `AuthClientModule`; this module keeps only the HTTP
 * controller and the tax-rule service, which is property configuration rather
 * than authorization state.
 */
@Module({
  imports: [AuditModule],
  controllers: [UsersController],
  providers: [TaxRulesService],
})
export class UsersModule {}
