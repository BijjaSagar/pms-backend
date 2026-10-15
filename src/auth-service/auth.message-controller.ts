import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_MESSAGES,
  type AckResult,
  type LoginResult,
  type PrincipalResult,
  type RequestMeta,
} from '../contracts/auth.messages.js';
import { toRpcException } from '../common/rpc-to-http.js';
import { AuthService, type AuthMeView } from './auth.service.js';

/**
 * Session and identity commands.
 *
 * These are the same operations the HTTP `AuthController` used to call directly
 * before the split; only the entry point changed. Each handler funnels through
 * `run` so a thrown HTTP exception is converted to a transport-safe
 * `RpcException` the gateway can rebuild.
 */
@Controller()
export class AuthMessageController {
  constructor(private readonly auth: AuthService) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRpcException(error);
    }
  }

  @MessagePattern(AUTH_MESSAGES.LOGIN)
  login(@Payload() data: { email: string; password: string; meta: RequestMeta }): Promise<LoginResult> {
    return this.run(async () => {
      const result = await this.auth.login(data.email, data.password, data.meta);
      // Dates do not survive JSON serialisation, so the expiry travels as an
      // ISO string the gateway turns back into a Date for the cookie max-age.
      return {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        userId: result.userId,
        organizationId: result.organizationId,
        activePropertyId: result.activePropertyId,
      };
    });
  }

  @MessagePattern(AUTH_MESSAGES.LOGOUT)
  logout(@Payload() data: { token: string; meta: RequestMeta }): Promise<AckResult> {
    return this.run(async () => {
      await this.auth.logout(data.token, data.meta);
      return { ok: true } as const;
    });
  }

  @MessagePattern(AUTH_MESSAGES.PRINCIPAL)
  principal(@Payload() data: { token?: string }): Promise<PrincipalResult | null> {
    return this.run(async () => {
      const principal = await this.auth.resolveSession(data.token);
      if (!principal) return null;
      // Permissions are resolved per request so a role change or deactivation
      // takes effect immediately rather than waiting for a session to expire.
      const permissions = principal.activePropertyId
        ? await this.auth.permissionsForProperty(principal.userId, principal.activePropertyId)
        : [];
      return { principal, permissions };
    });
  }

  @MessagePattern(AUTH_MESSAGES.ME)
  me(@Payload() data: { userId: string; activePropertyId: string | null }): Promise<AuthMeView> {
    return this.run(() => this.auth.buildMe(data.userId, data.activePropertyId));
  }

  @MessagePattern(AUTH_MESSAGES.SWITCH_PROPERTY)
  switchProperty(
    @Payload() data: { userId: string; sessionId: string; propertyId: string; meta: RequestMeta },
  ): Promise<AckResult> {
    return this.run(async () => {
      await this.auth.switchProperty(data.userId, data.sessionId, data.propertyId, data.meta);
      return { ok: true } as const;
    });
  }

  /** Liveness probe for the gateway's `/health/auth` endpoint. */
  @MessagePattern(AUTH_MESSAGES.PING)
  ping(): { status: string } {
    return { status: 'ok' };
  }
}
