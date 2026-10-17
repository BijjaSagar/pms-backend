import {
  CanActivate,
  ExecutionContext,
  HttpException,
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
 * Populates request.user from either session cookie or Bearer access token.
 *
 * Runs before PermissionsGuard so that guard only ever sees a user that came
 * from trusted server-side session resolution. Honours @Public(), which is what
 * makes login, health and password-reset reachable without a session.
 *
 * Fails closed: if Redis is unreachable or returns an error, unauthorized
 * access is strictly rejected.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authClient: AuthClientService,
  ) {}

  private extractToken(req: Request): string | undefined {
    // 1. Check session cookie
    const cookieToken = req.cookies?.[SESSION_COOKIE];
    if (cookieToken && typeof cookieToken === 'string' && cookieToken.trim()) {
      return cookieToken.trim();
    }

    // 2. Check Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      const [type, token] = authHeader.split(' ');
      if (type?.toLowerCase() === 'bearer' && token?.trim()) {
        return token.trim();
      }
    }

    return undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const target = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, target);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(req);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let resolved: PrincipalResult | null = null;
    try {
      resolved = await this.authClient.request<PrincipalResult | null>(
        AUTH_MESSAGES.PRINCIPAL,
        { token },
      );
    } catch (err) {
      // If the auth microservice returned an explicit HTTP error (e.g. 401 token expired/invalid signature),
      // bubble it up directly.
      if (err instanceof HttpException) {
        throw err;
      }
      // Redis failure or microservice disconnect: FAIL CLOSED!
      throw new UnauthorizedException('Authentication service temporarily unavailable');
    }

    if (!resolved || !resolved.principal) {
      throw new UnauthorizedException('Invalid or expired authentication credentials');
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
