import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { toRpcException } from '../common/rpc-to-http.js';
import type { DateOnly } from '../common/dates.js';
import type { ActorContext } from '../contracts/shared.js';
import { STAY_MESSAGES } from '../contracts/booking.messages.js';
import { FrontDeskService } from './front-desk.service.js';

/** Check-in, check-out, extend and the front-desk boards. */
@Controller()
export class FrontDeskMessageController {
  constructor(private readonly frontDesk: FrontDeskService) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRpcException(error);
    }
  }

  @MessagePattern(STAY_MESSAGES.CHECK_IN)
  checkIn(@Payload() d: { actor: ActorContext; id: string; overrideReason?: string }) {
    return this.run(() => this.frontDesk.checkIn(d.actor, d.id, { overrideReason: d.overrideReason }));
  }

  @MessagePattern(STAY_MESSAGES.CHECK_OUT)
  checkOut(@Payload() d: { actor: ActorContext; id: string; overrideReason?: string }) {
    return this.run(() => this.frontDesk.checkOut(d.actor, d.id, { overrideReason: d.overrideReason }));
  }

  @MessagePattern(STAY_MESSAGES.EXTEND)
  extend(@Payload() d: { actor: ActorContext; id: string; newCheckOutDate: string }) {
    return this.run(() => this.frontDesk.extend(d.actor, d.id, d.newCheckOutDate as DateOnly));
  }

  @MessagePattern(STAY_MESSAGES.ARRIVALS)
  arrivals(@Payload() d: { actor: ActorContext }) {
    return this.run(() => this.frontDesk.arrivals(d.actor));
  }

  @MessagePattern(STAY_MESSAGES.DEPARTURES)
  departures(@Payload() d: { actor: ActorContext }) {
    return this.run(() => this.frontDesk.departures(d.actor));
  }

  @MessagePattern(STAY_MESSAGES.IN_HOUSE)
  inHouse(@Payload() d: { actor: ActorContext }) {
    return this.run(() => this.frontDesk.inHouse(d.actor));
  }
}
