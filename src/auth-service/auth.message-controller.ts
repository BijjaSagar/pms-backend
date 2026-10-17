import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_MESSAGES,
  type AckResult,
  type ForgotPasswordResult,
  type LoginResult,
  type PrincipalResult,
  type RefreshResult,
  type RequestMeta,
  type ResetPasswordResult,
} from '../contracts/auth.messages.js';
import { toRpcException } from '../common/rpc-to-http.js';
import { AuthService, type AuthMeView } from './auth.service.js';

/**
 * Session, identity, and security commands.
 *
 * Runs inside the auth microservice. Translates incoming RPC payloads into
 * AuthService operations and maps thrown exceptions into transport-safe
 * RpcExceptions.
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
      return {
        token: result.token,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt.toISOString(),
        userId: result.userId,
        organizationId: result.organizationId,
        activePropertyId: result.activePropertyId,
      };
    });
  }

  @MessagePattern(AUTH_MESSAGES.REFRESH)
  refresh(@Payload() data: { refreshToken: string; meta: RequestMeta }): Promise<RefreshResult> {
    return this.run(() => this.auth.refresh(data.refreshToken, data.meta));
  }

  @MessagePattern(AUTH_MESSAGES.LOGOUT)
  logout(@Payload() data: { token: string; meta: RequestMeta }): Promise<AckResult> {
    return this.run(async () => {
      await this.auth.logout(data.token, data.meta);
      return { ok: true } as const;
    });
  }

  @MessagePattern(AUTH_MESSAGES.LOGOUT_ALL)
  logoutAll(@Payload() data: { userId: string; meta: RequestMeta }): Promise<AckResult> {
    return this.run(async () => {
      await this.auth.logoutAll(data.userId, data.meta);
      return { ok: true } as const;
    });
  }

  @MessagePattern(AUTH_MESSAGES.FORGOT_PASSWORD)
  forgotPassword(
    @Payload() data: { email: string; meta: RequestMeta },
  ): Promise<ForgotPasswordResult> {
    return this.run(() => this.auth.forgotPassword(data.email, data.meta));
  }

  @MessagePattern(AUTH_MESSAGES.RESET_PASSWORD)
  resetPassword(
    @Payload() data: { token: string; password: string; meta: RequestMeta },
  ): Promise<ResetPasswordResult> {
    return this.run(() => this.auth.resetPassword(data.token, data.password, data.meta));
  }

  @MessagePattern(AUTH_MESSAGES.PRINCIPAL)
  principal(@Payload() data: { token?: string }): Promise<PrincipalResult | null> {
    return this.run(async () => {
      const principal = await this.auth.resolveSession(data.token);
      if (!principal) return null;
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
