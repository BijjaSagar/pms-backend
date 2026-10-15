import { Controller, MessageEvent, Req, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';
import type { BookingEvent } from '../contracts/booking.messages.js';
import { RealtimeService } from './realtime.service.js';

/** Heartbeat cadence; keeps intermediaries from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream of availability changes for the caller's property.
 *
 * The session cookie authenticates the connection (the browser sends it
 * automatically), so the global guards run as on any other route and the stream
 * is scoped to the active property. The client ignores events it caused itself
 * by matching `holdId`/`userId`.
 */
@Controller()
export class AvailabilityStreamController {
  constructor(private readonly realtime: RealtimeService) {}

  @RequirePermissions('reservation.read')
  @Sse('availability/stream')
  stream(@Req() req: AuthenticatedRequest): Observable<MessageEvent> {
    const propertyId = req.user!.activePropertyId;

    return new Observable<MessageEvent>((subscriber) => {
      const off = this.realtime.onBooking((event: BookingEvent) => {
        if (event.propertyId !== propertyId) return;
        subscriber.next({ data: event } as MessageEvent);
      });

      const heartbeat = setInterval(() => {
        subscriber.next({ data: { type: 'ping' } } as MessageEvent);
      }, HEARTBEAT_MS);

      return () => {
        off();
        clearInterval(heartbeat);
      };
    });
  }
}
