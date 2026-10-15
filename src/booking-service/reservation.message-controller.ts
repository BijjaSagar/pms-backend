import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { toRpcException } from '../common/rpc-to-http.js';
import type { DateOnly } from '../common/dates.js';
import type { ActorContext } from '../contracts/shared.js';
import {
  HOLD_MESSAGES,
  RESERVATION_MESSAGES,
  type CreateReservationInput,
  type ReservationListOptions,
} from '../contracts/booking.messages.js';
import { ReservationsService } from './reservations.service.js';
import { RoomHoldService } from './room-hold.service.js';

/**
 * Reservation, availability and room-hold commands.
 *
 * Each handler funnels through `run` so a thrown HTTP exception becomes a
 * transport-safe `RpcException` the gateway rebuilds with the same status code.
 */
@Controller()
export class ReservationMessageController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly holds: RoomHoldService,
  ) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRpcException(error);
    }
  }

  @MessagePattern(RESERVATION_MESSAGES.LIST)
  list(@Payload() d: { actor: ActorContext; opts: ReservationListOptions }) {
    return this.run(() => this.reservations.list(d.actor, d.opts));
  }

  @MessagePattern(RESERVATION_MESSAGES.AVAILABILITY)
  availability(@Payload() d: { actor: ActorContext; roomTypeId: string; checkIn: string; checkOut: string }) {
    return this.run(() =>
      this.reservations.availability(d.actor, d.roomTypeId, d.checkIn as DateOnly, d.checkOut as DateOnly),
    );
  }

  @MessagePattern(RESERVATION_MESSAGES.CREATE)
  create(@Payload() d: { actor: ActorContext; input: CreateReservationInput }) {
    return this.run(() => this.reservations.create(d.actor, d.input));
  }

  @MessagePattern(RESERVATION_MESSAGES.DETAIL)
  detail(@Payload() d: { actor: ActorContext; id: string }) {
    return this.run(() => this.reservations.detail(d.actor, d.id));
  }

  @MessagePattern(RESERVATION_MESSAGES.UPDATE)
  update(@Payload() d: { actor: ActorContext; id: string; body: Record<string, unknown> }) {
    return this.run(() => this.reservations.update(d.actor, d.id, d.body));
  }

  @MessagePattern(RESERVATION_MESSAGES.ASSIGN_ROOM)
  assignRoom(@Payload() d: { actor: ActorContext; id: string; roomId: string }) {
    return this.run(() => this.reservations.assignRoom(d.actor, d.id, d.roomId));
  }

  @MessagePattern(RESERVATION_MESSAGES.CANCEL)
  cancel(@Payload() d: { actor: ActorContext; id: string; reason: string }) {
    return this.run(() => this.reservations.cancel(d.actor, d.id, d.reason));
  }

  // --------------------------------------------------------------- room holds

  @MessagePattern(HOLD_MESSAGES.ACQUIRE)
  acquire(@Payload() d: { actor: ActorContext; roomId: string; checkIn: string; checkOut: string }) {
    return this.run(() => this.holds.acquire(d.actor, d.roomId, d.checkIn as DateOnly, d.checkOut as DateOnly));
  }

  @MessagePattern(HOLD_MESSAGES.REFRESH)
  refresh(@Payload() d: { actor: ActorContext; holdId: string }) {
    return this.run(() => this.holds.refresh(d.actor, d.holdId));
  }

  @MessagePattern(HOLD_MESSAGES.RELEASE)
  release(@Payload() d: { actor: ActorContext; holdId: string }) {
    return this.run(() => this.holds.release(d.actor, d.holdId));
  }
}
