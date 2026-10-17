/**
 * Constants shared by the gateway and the auth microservice.
 *
 * SESSION_COOKIE and REFRESH_COOKIE are read and written by the gateway (cookie handling and the
 * session guard) while the auth microservice only ever sees the raw token, so
 * the name lives here rather than on either side alone. Keeping it in one place
 * means the cookie the gateway sets is the one the guard reads.
 */
export const SESSION_COOKIE = 'hotel_pms_session';
export const REFRESH_COOKIE = 'hotel_pms_refresh';
