import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { RolesService, TaxRulesService } from './roles.service.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * Staff, roles and system settings.
 *
 * AuditModule is imported because every mutation here records who granted which
 * role to whom. "Who gave this person admin" is not answerable from the
 * membership row alone, and by the time it is asked the answer needs to still
 * be there.
 */
@Module({
  imports: [AuditModule],
  controllers: [UsersController],
  providers: [UsersService, RolesService, TaxRulesService],
  exports: [UsersService, RolesService, TaxRulesService],
})
export class UsersModule {}