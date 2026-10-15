/**
 * Postgres unique_violation detection.
 *
 * The contract client surfaces the constraint name in the error message but does
 * not always carry the SQLSTATE, so either signal is accepted. Matching on the
 * constraint name is what lets a caller tell one guarantee from another (a
 * booking-code collision vs a room-night collision vs an idempotency replay).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const message = typeof e.message === 'string' ? e.message : '';
  const isUnique =
    e.code === '23505' || /duplicate key value violates unique constraint/i.test(message);
  if (!isUnique) return false;
  return constraint ? message.includes(constraint) : true;
}

export const UNIQUE = {
  ROOM_NIGHT: 'RoomNightInventory_roomId_stayDate_key',
  RESERVATION_ROOM_NIGHT: 'RoomNightInventory_reservationRoomId_stayDate_key',
  BOOKING_CODE: 'Reservation_propertyId_bookingCode_key',
  IDEMPOTENCY_KEY: 'Reservation_idempotencyKey_key',
} as const;
