import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { AppConfigModule } from './config/config.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { PropertyModule } from './properties/properties.module.js';
import { GuestReservationModule } from './reservations/reservations.module.js';
import { DatabaseExceptionFilter } from './common/filters/database-exception.filter.js';
import { CsrfMiddleware } from './common/middleware/csrf.middleware.js';

/**
 * Global per-IP request ceiling.
 *
 * Environment-driven so scripted harnesses can raise it locally without
 * touching code. The default is the production value.
 */
const GLOBAL_RATE_LIMIT = parseInt(process.env['RATE_LIMIT_PER_MINUTE'] ?? '120', 10);
import { FrontDeskModule } from './front-desk/front-desk.module.js';
import { HousekeepingModule } from './housekeeping/housekeeping.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    PropertyModule,
    GuestReservationModule,
    FrontDeskModule,
    HousekeepingModule,
    ReportsModule,
    UsersModule,
    // Global default. Individual routes tighten this, notably POST /auth/login.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: GLOBAL_RATE_LIMIT }]),
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: throttling, then authentication (populates request.user),
    // then permissions. PermissionsGuard must never run before AuthGuard.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Registered last so raw database errors become business-readable codes
    // rather than leaking a 500 with driver internals.
    { provide: APP_FILTER, useClass: DatabaseExceptionFilter },
    CsrfMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Applies to every route including health, because the check is cheap and
    // refusing a foreign-origin mutation before it reaches a guard means a
    // cross-site attempt is rejected regardless of whether it holds a session.
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}