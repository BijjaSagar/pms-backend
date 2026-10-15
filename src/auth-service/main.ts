import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AuthServiceModule } from './auth-service.module.js';

/**
 * Auth microservice entry point.
 *
 * Runs a Redis transport with no HTTP surface. The gateway owns every public
 * endpoint and forwards the auth/staff/role commands over this channel.
 */
async function bootstrap() {
  const host = process.env['REDIS_HOST'] ?? '127.0.0.1';
  const port = parseInt(process.env['REDIS_PORT'] ?? '6379', 10);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AuthServiceModule, {
    transport: Transport.REDIS,
    options: { host, port },
  });

  await app.listen();
  console.log(`Auth microservice listening on redis://${host}:${port}`);
}

await bootstrap();
