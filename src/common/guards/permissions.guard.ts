import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS,
  SKIP_PERMISSION_CHECK,
} from '../decorators/access.decorator.js';
import type { AuthenticatedRequest } from './auth.guard.js';

/**
 * Deny-by-default permission gate.
 *
 * A protected route that does not declare @RequirePermissions is rejected rather
 * than allowed, so forgetting the decorator fails safe rather than open. This
 * guard only answers "does this role hold the key"; record-level property
 * scoping and business rules stay in the service layer.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const target = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, target);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user || !user.id || !user.isActive) {
      throw new UnauthorizedException();
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_PERMISSION_CHECK, target);
    if (skip) return true;

    if (!user.activePropertyId) {
      throw new UnauthorizedException('Select an active property first');
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, target);
    if (!required || required.length === 0) {
      throw new ForbiddenException('Route has no explicit permission policy');
    }

    const granted = new Set(user.permissions ?? []);
    const allowed = required.every((permission) => granted.has(permission));
    if (!allowed) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }

    return true;
  }
}