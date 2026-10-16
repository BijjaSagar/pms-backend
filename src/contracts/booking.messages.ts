/**
 * Wire contract between the HTTP gateway and the booking microservice.
 *
 * The gateway owns the HTTP surface (routing, DTO validation, permission
 * decorators) and the booking microservice owns reservation, stay, folio and
 * invoice state plus the Redis room holds. Everything that crosses between them
 * is named here so the two processes cannot drift. Values are plain data — the
 * Redis transport JSON-serialises them, so no Date, class instance or Express
 * request is ever sent.
 */
import type { ActorContext, RequestMeta } from './shared.js';

/** Reservation and availability commands. */
export const RESERVATION_MESSAGES = {
  LIST: 'reservation.list',
  AVAILABILITY: 'reservation.availability',
  CREATE: 'reservation.create',
  DETAIL: 'reservation.detail',
  UPDATE: 'reservation.update',
  ASSIGN_ROOM: 'reservation.assign-room',
  CANCEL: 'reservation.cancel',
} as const;

/** Selection-time room holds that stop two users booking the same room-night. */
export const HOLD_MESSAGES = {
  ACQUIRE: 'hold.acquire',
  REFRESH: 'hold.refresh',
  RELEASE: 'hold.release',
} as const;

/** Check-in, check-out, extend and the front-desk boards. */
export const STAY_MESSAGES = {
  CHECK_IN: 'stay.check-in',
  CHECK_OUT: 'stay.check-out',
  EXTEND: 'stay.extend',
  ARRIVALS: 'stay.arrivals',
  DEPARTURES: 'stay.departures',
  IN_HOUSE: 'stay.in-house',
} as const;

/** Folio ledger, payments and refunds. */
export const FOLIO_MESSAGES = {
  BALANCE: 'folio.balance',
  DETAIL: 'folio.detail',
  CLOSE: 'folio.close',
  REOPEN: 'folio.reopen',
  VOID_ITEM: 'folio.void-item',
  POST_CHARGE: 'folio.post-charge',
  RECORD_PAYMENT: 'folio.record-payment',
  REFUND: 'folio.refund',
} as const;

/** Invoices and the property payment ledger. */
export const INVOICE_MESSAGES = {
  LIST: 'invoice.list',
  PREVIEW: 'invoice.preview',
  ISSUE: 'invoice.issue',
  VOID: 'invoice.void',
  PAYMENT_LEDGER: 'payment.ledger',
} as const;

/** Service liveness probe. */
export const BOOKING_MESSAGES = {
  PING: 'booking.ping',
} as const;

/**
 * Redis pub/sub channel carrying availability changes to the gateway, which
 * fans them out to browsers over Server-Sent Events.
 */
export const BOOKING_EVENTS_CHANNEL = 'booking.events';

/** Why a room's availability changed. */
export type BookingEventType = 'hold' | 'release' | 'booked' | 'cancelled';

/**
 * One availability change. `nights` are the affected stay dates (YYYY-MM-DD) so
 * a client can invalidate exactly the rooms it is showing.
 */
export interface BookingEvent {
  type: BookingEventType;
  propertyId: string;
  roomId: string | null;
  nights: string[];
  /** Set for hold/release so a client can ignore its own hold. */
  holdId: string | null;
  /** The user who caused the change, so a client can ignore its own actions. */
  userId: string | null;
  at: string;
}

/** Reservation list filters, mirroring the HTTP query parameters. */
export interface ReservationListOptions {
  status?: string;
  checkIn?: string;
  checkOut?: string;
  search?: string;
  page: number;
  pageSize: number;
}

/** Reservation creation input (already validated at the HTTP boundary). */
export interface CreateReservationInput {
  primaryGuestId: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  roomTypeId: string;
  roomId?: string | null;
  source?: string;
  notes?: string | null;
  /** Hold to convert into permanent inventory, when the user selected a room. */
  holdId?: string | null;
  /** Makes a retried create idempotent: a replay returns the same booking. */
  idempotencyKey?: string | null;
  /** Optional extras/additions to add to the folio at booking time. */
  extras?: Array<{
    name: string;
    chargeUnit: 'per_night' | 'per_stay' | 'per_guest' | 'per_room';
    quantity: number;
    unitRate: string;
    taxable?: boolean;
  }>;
  /** Optional discount to apply against the stay total. */
  discount?: string;
}

/** Result of acquiring or refreshing a hold. */
export interface HoldResult {
  holdId: string;
  roomId: string;
  nights: string[];
  expiresAt: string;
  /** Milliseconds until the hold lapses, from server time. */
  remainingMs: number;
}

/** Post-charge input for a folio. */
export interface PostChargeInput {
  type: string;
  description: string;
  quantity: number;
  unitAmount: string;
  postedById?: string | null;
  idempotencyKey?: string | null;
  taxable?: boolean;
}

/** Payment input for a folio. */
export interface RecordPaymentInput {
  amount: string;
  method: string;
  reference?: string | null;
  receivedById?: string | null;
  idempotencyKey?: string | null;
}

export type { ActorContext, RequestMeta };
