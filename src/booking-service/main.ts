import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { BookingServiceModule } from './booking-service.module.js';

/**
 * Booking microservice entry point.
 *
 * Runs a Redis transport with no HTTP surface. The gateway owns every public
 * endpoint and forwards reservation, stay, folio and hold commands over this
 * channel. The same Redis instance also carries room-hold state and the
 * availability pub/sub channel.
 */
async function bootstrap() {
  const host = process.env['REDIS_HOST'] ?? '127.0.0.1';
  const port = parseInt(process.env['REDIS_PORT'] ?? '6379', 10);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(BookingServiceModule, {
    transport: Transport.REDIS,
    options: { host, port },
  });

  await app.listen();
  console.log(`Booking microservice listening on redis://${host}:${port}`);
}

await bootstrap();
