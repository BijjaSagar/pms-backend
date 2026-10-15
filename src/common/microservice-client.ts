import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { rpcErrorToHttpException } from './rpc-to-http.js';

/**
 * Base for a gateway-side handle on a Redis-backed microservice.
 *
 * Owns one `ClientProxy` for the process and exposes a single `request` method
 * that turns the Observable into a promise and rebuilds the HTTP exception from
 * whatever the service threw. Subclasses only differ by which service they
 * address, so controllers read as `await this.client.request(PATTERN, payload)`.
 */
export abstract class MicroserviceClient implements OnModuleInit, OnModuleDestroy {
  protected readonly logger: Logger;
  private readonly client: ClientProxy;

  constructor(config: ConfigService) {
    this.logger = new Logger(this.constructor.name);
    this.client = ClientProxyFactory.create({
      transport: Transport.REDIS,
      options: {
        host: config.get<string>('redis.host') ?? '127.0.0.1',
        port: config.get<number>('redis.port') ?? 6379,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly so a missing broker fails at boot with a clear log line
    // rather than on the first request.
    await this.client.connect();
    this.logger.log('Connected to microservice transport (Redis)');
  }

  async onModuleDestroy(): Promise<void> {
    this.client.close();
  }

  async request<TResponse>(pattern: string, payload: unknown): Promise<TResponse> {
    try {
      return await firstValueFrom(this.client.send<TResponse, unknown>(pattern, payload));
    } catch (error) {
      throw rpcErrorToHttpException(error);
    }
  }
}
