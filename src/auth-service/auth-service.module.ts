import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { UsersService } from './users.service.js';
import { RolesService } from './roles.service.js';
import { AuthMessageController } from './auth.message-controller.js';
import { UsersMessageController } from './users.message-controller.js';

/**
 * The auth microservice.
 *
 * Owns session, staff, role and permission state. It shares the Postgres
 * database and the audit module with the gateway — the split is at the process
 * and transport boundary, not the data boundary — so a login writes its audit
 * row through the same `AuditService` the rest of the system uses.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, AuditModule],
  controllers: [AuthMessageController, UsersMessageController],
  providers: [AuthService, TokenService, UsersService, RolesService],
})
export class AuthServiceModule {}
