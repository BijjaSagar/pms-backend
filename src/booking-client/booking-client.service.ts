import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceClient } from '../common/microservice-client.js';

/**
 * The gateway's handle on the booking microservice.
 *
 * The constructor is declared explicitly: Nest reads DI metadata off the
 * concrete class, and a subclass without its own constructor carries none.
 */
@Injectable()
export class BookingClientService extends MicroserviceClient {
  constructor(config: ConfigService) {
    super(config);
  }
}
