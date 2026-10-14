import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/access.decorator.js';
import { DatabaseService } from '../database/database.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

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
}
