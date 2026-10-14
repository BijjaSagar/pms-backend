import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Maps database driver failures onto business-readable HTTP responses.
 *
 * This has to be a filter rather than a try/catch inside the service: the
 * transaction wrapper rethrows the underlying driver error, so a
 * ConflictException raised inside the transaction callback does not survive the
 * boundary. Catching the code at the edge is the only place that reliably
 * sees it.
 *
 * The guard that matters most is RoomNightInventory's unique constraint on
 * (roomId, stayDate). Losing that race is a conflict the caller can act on,
 * not a server fault, so it must never surface as a 500.
 *
 * Driver error codes are matched on the code where available and on message
 * text as a fallback, because the code does not always survive the transaction
 * boundary. Anything unmatched is logged in full server-side and reported to
 * the client as a bare 500, so driver internals never leak.
 */
@Catch()
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Database');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    // Deliberately a catch-all, because the driver error surfaces as an unknown
    // type. Anything Nest already classified must pass through untouched.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const err = exception as {
      code?: string;
      sqlState?: string;
      message?: string;
      cause?: { code?: string; message?: string };
      stack?: string;
    } | null;

    // The driver error arrives without a top-level `code` once it has crossed
    // the transaction boundary, so detection is message-based rather than
    // depending on where the code happened to land.
    const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
    const code = err?.code ?? err?.sqlState ?? err?.cause?.code;

    if (code === '23505' || /duplicate key value violates unique constraint/i.test(text)) {
      const body = text.includes('RoomNightInventory_roomId_stayDate_key')
        ? 'Room availability changed; refresh and choose another room.'
        : text.includes('Reservation_propertyId_bookingCode_key')
          ? 'Could not allocate a unique booking code; please retry.'
          : 'That value is already in use.';
      res.status(HttpStatus.CONFLICT).json({ statusCode: HttpStatus.CONFLICT, message: body });
      return;
    }

    // A value that is not a valid identifier never reaches a service's own
    // NotFound check, because the lookup cannot be performed at all. Reporting
    // it as a 500 blames the server for what is plainly a malformed request, and
    // 404 would be worse still — it asserts a resource is absent when in fact
    // the caller never named one. 400 says what actually went wrong, and applies
    // equally to a bad path parameter and a bad body field.
    if (code === '22P02' || /invalid (input|text) syntax|invalid uuid|invalid UUID/i.test(text)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'A supplied identifier is not valid. Check the id and try again.',
      });
      return;
    }

    // Truncation means a value exceeded its column length. Also the caller's
    // mistake, and one worth naming precisely rather than reporting as a fault.
    if (code === '22001' || /value too long for type|too long for character varying/i.test(text)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'A supplied value is longer than the field allows.',
      });
      return;
    }

    // A check-constraint violation is a business rule refusing the value. 422
    // rather than 400 because the request was well formed, just not acceptable.
    if (code === '23514' || /violates check constraint/i.test(text)) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'The value is not allowed by a database rule.',
      });
      return;
    }

    // A dangling reference means a related record does not exist. 409 rather
    // than 404: the record named in the path may well exist, the one it points
    // at does not.
    if (code === '23503' || /violates foreign key constraint/i.test(text)) {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: 'A related record does not exist.',
      });
      return;
    }

    this.logger.error(
      `unhandled: ${code ?? 'no-code'} ${String(err?.message ?? exception).slice(0, 300)}\n${err?.stack ?? '(no stack)'}`,
    );
    // Never leak driver text, SQL or stack traces to the client.
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}