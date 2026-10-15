import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_ROUTE } from '../decorators/access.decorator.js';
import { SESSION_COOKIE } from '../auth.constants.js';
import { AuthClientService } from '../../auth-client/auth-client.service.js';
import { AUTH_MESSAGES, type PrincipalResult } from '../../contracts/auth.messages.js';
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
 *
 * Session resolution and permission lookup now happen in the auth microservice,
 * so this is a single transport round-trip that returns both. Permissions are
 * still resolved per request from the current membership, so a role change or
 * deactivation takes effect immediately rather than waiting for a stale session
 * claim to expire.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authClient: AuthClientService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const target = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, target);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = req.cookies?.[SESSION_COOKIE];

    const resolved = await this.authClient.request<PrincipalResult | null>(
      AUTH_MESSAGES.PRINCIPAL,
      { token },
    );
    if (!resolved) {
      throw new UnauthorizedException();
    }

    req.user = {
      id: resolved.principal.userId,
      organizationId: resolved.principal.organizationId,
      activePropertyId: resolved.principal.activePropertyId,
      sessionId: resolved.principal.sessionId,
      permissions: resolved.permissions,
      isActive: true,
    };
    return true;
  }
}
