import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

/**
 * Translates an exception across the microservice boundary without losing its
 * meaning.
 *
 * The old in-process services threw Nest HTTP exceptions, and the verification
 * suites assert on the exact status codes (401 for a missing session, 403 for a
 * denied permission, 409 for a duplicate invite). Over the Redis transport an
 * error is serialised to plain data, so the status has to be carried explicitly
 * and rebuilt on the other side. `toRpcException` runs inside the auth service;
 * `rpcErrorToHttpException` runs in the gateway.
 */

/** Service side: turns any thrown error into a transport-safe RpcException. */
export function toRpcException(error: unknown): RpcException {
  if (error instanceof RpcException) return error;

  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ?? error.message);
    return new RpcException({ status: error.getStatus(), message });
  }

  return new RpcException({
    status: 500,
    message: error instanceof Error ? error.message : 'Internal server error',
  });
}

/** Gateway side: rebuilds the HTTP exception from the transport error. */
export function rpcErrorToHttpException(error: unknown): HttpException {
  const raw = error instanceof RpcException ? error.getError() : error;

  let status = 500;
  let message: string | string[] = 'Internal server error';

  if (raw && typeof raw === 'object') {
    const shape = raw as { status?: unknown; statusCode?: unknown; message?: unknown };
    const candidate = shape.status ?? shape.statusCode;
    if (typeof candidate === 'number') status = candidate;
    if (typeof shape.message === 'string' || Array.isArray(shape.message)) {
      message = shape.message as string | string[];
    }
  } else if (typeof raw === 'string') {
    message = raw;
  }

  switch (status) {
    case 400:
      return new BadRequestException(message);
    case 401:
      return new UnauthorizedException(message);
    case 403:
      return new ForbiddenException(message);
    case 404:
      return new NotFoundException(message);
    case 409:
      return new ConflictException(message);
    default:
      return new HttpException(message, status);
  }
}
