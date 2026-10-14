import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_ROUTE } from '../decorators/access.decorator.js';
import { AuthService, SESSION_COOKIE } from '../../auth/auth.service.js';
import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  activePropertyId: string | null;
  sessionId: string;
  permissions: string[];
  isActive: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Populates request.user from the session cookie.
 *
 * Runs before PermissionsGuard so that guard only ever sees a user that came
 * from trusted server-side session resolution. Honours @Public(), which is what
 * makes login, health and password-reset reachable without a session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const target = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, target);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = req.cookies?.[SESSION_COOKIE];

    const principal = await this.auth.resolveSession(token);
    if (!principal) {
      throw new UnauthorizedException();
    }

    // Permissions are resolved per request from the current membership so a
    // role change or deactivation takes effect immediately rather than waiting
    // for a stale session claim to expire.
    const permissions = principal.activePropertyId
      ? await this.auth.permissionsForProperty(principal.userId, principal.activePropertyId)
      : [];

    req.user = {
      id: principal.userId,
      organizationId: principal.organizationId,
      activePropertyId: principal.activePropertyId,
      sessionId: principal.sessionId,
      permissions,
      isActive: true,
    };
    return true;
  }
}