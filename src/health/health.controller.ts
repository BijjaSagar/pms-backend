import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/access.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { AuthClientService } from '../auth-client/auth-client.service.js';
import { BookingClientService } from '../booking-client/booking-client.service.js';
import { AUTH_MESSAGES } from '../contracts/auth.messages.js';
import { BOOKING_MESSAGES } from '../contracts/booking.messages.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly authClient: AuthClientService,
    private readonly bookingClient: BookingClientService,
  ) {}

  @Public()
  @Get()
  liveness() {
    return { status: 'ok' };
  }

  @Public()
  @Get('db')
  async readiness() {
    try {
      const { latencyMs } = await this.database.checkConnection();
      return { status: 'ok', database: 'up', latencyMs };
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
        message: err instanceof Error ? err.message : 'Database unreachable',
      });
    }
  }

  /**
   * Verifies the whole auth path: gateway → Redis → auth microservice.
   *
   * The session guard depends on that channel for every authenticated request,
   * so a broker or service outage should be visible here before it shows up as
   * a wall of failed logins.
   */
  @Public()
  @Get('auth')
  async authReadiness() {
    try {
      const result = await this.authClient.request<{ status: string }>(AUTH_MESSAGES.PING, {});
      return { status: 'ok', auth: result.status };
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'error',
        auth: 'down',
        message: err instanceof Error ? err.message : 'Auth service unreachable',
      });
    }
  }

  /**
   * Verifies the booking path: gateway → Redis → booking microservice.
   */
  @Public()
  @Get('booking')
  async bookingReadiness() {
    try {
      const result = await this.bookingClient.request<{ status: string }>(BOOKING_MESSAGES.PING, {});
      return { status: 'ok', booking: result.status };
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'error',
        booking: 'down',
        message: err instanceof Error ? err.message : 'Booking service unreachable',
      });
    }
  }
}
