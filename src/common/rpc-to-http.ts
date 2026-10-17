import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { isUniqueViolation } from './db-errors.js';

/**
 * Strips database connection credentials, passwords, and raw secrets from error messages
 * before they cross the microservice or HTTP boundary.
 */
function sanitizeMessage(msg: unknown): string | string[] {
  if (Array.isArray(msg)) {
    return msg.map((m) => (typeof m === 'string' ? sanitizeMessage(m) as string : m));
  }
  if (typeof msg !== 'string') return 'Internal server error';
  return msg
    .replace(/postgres(ql)?:\/\/[^@\s]+@[^\s]+/gi, 'postgresql://***:***@...')
    .replace(/(password|token|secret|key)=['"]?[^'"\s]+['"]?/gi, '$1=***');
}

/** Service side: turns any thrown error into a transport-safe RpcException. */
export function toRpcException(error: unknown): RpcException {
  if (error instanceof RpcException) return error;

  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ?? error.message);
    return new RpcException({ status: error.getStatus(), message: sanitizeMessage(message) });
  }

  if (isUniqueViolation(error)) {
    return new RpcException({
      status: 409,
      message: 'That value already exists. Duplicate entry was rejected.',
    });
  }

  const errMessage = error instanceof Error ? error.message : 'Internal server error';
  return new RpcException({
    status: 500,
    message: sanitizeMessage(errMessage),
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
      message = sanitizeMessage(shape.message);
    }
  } else if (typeof raw === 'string') {
    message = sanitizeMessage(raw);
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
