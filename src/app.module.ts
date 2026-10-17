import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AppConfigModule } from './config/config.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthClientModule } from './auth-client/auth-client.module.js';
import { BookingClientModule } from './booking-client/booking-client.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { PropertyModule } from './properties/properties.module.js';
import { GuestReservationModule } from './reservations/reservations.module.js';
import { FrontDeskModule } from './front-desk/front-desk.module.js';
import { HousekeepingModule } from './housekeeping/housekeeping.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { UsersModule } from './users/users.module.js';
import { DatabaseExceptionFilter } from './common/filters/database-exception.filter.js';
import { CsrfMiddleware } from './common/middleware/csrf.middleware.js';

import { ConfigService } from '@nestjs/config';
import { RedisThrottlerStorage } from './common/redis-throttler.storage.js';

/**
 * Global per-IP request ceiling.
 *
 * Environment-driven so scripted harnesses can raise it locally without
 * touching code. The default is the production value.
 */
const GLOBAL_RATE_LIMIT = parseInt(process.env['RATE_LIMIT_PER_MINUTE'] ?? '120', 10);

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    AuditModule,
    // Global client handle on the auth microservice; the session guard and the
    // auth/users controllers reach it without importing it themselves.
    AuthClientModule,
    // Global client handle on the booking microservice plus the live
    // availability stream (SSE) that pushes room holds to other browsers.
    BookingClientModule,
    RealtimeModule,
    AuthModule,
    PropertyModule,
    GuestReservationModule,
    FrontDeskModule,
    HousekeepingModule,
    ReportsModule,
    UsersModule,
    // Global distributed rate limiting across instances using Redis storage.
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: GLOBAL_RATE_LIMIT }],
        storage: new RedisThrottlerStorage(config),
      }),
    }),
  ],
  controllers: [],
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