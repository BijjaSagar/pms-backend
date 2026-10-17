import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

const LOGIN_RATE_LIMIT = parseInt(process.env['LOGIN_RATE_LIMIT_PER_MINUTE'] ?? '10', 10);

import { Public, SkipPermissionCheck } from '../common/decorators/access.decorator.js';
import { REFRESH_COOKIE, SESSION_COOKIE } from '../common/auth.constants.js';
import { AuthClientService } from '../auth-client/auth-client.service.js';
import {
  AUTH_MESSAGES,
  type AckResult,
  type ForgotPasswordResult,
  type LoginResult,
  type RefreshResult,
  type RequestMeta,
  type ResetPasswordResult,
} from '../contracts/auth.messages.js';
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshTokenDto,
  ResetPasswordDto,
  SwitchPropertyDto,
} from './dto/auth.dto.js';

interface AuthedRequest extends Request {
  user?: {
    id: string;
    organizationId: string;
    activePropertyId: string | null;
    sessionId: string;
    permissions: string[];
    isActive: boolean;
  };
}

/**
 * The public auth surface.
 *
 * Owns HTTP concerns: rate limiting, secure cookies (HttpOnly, SameSite, Secure),
 * DTO validation, and passes commands over transport to the auth microservice.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authClient: AuthClientService,
    private readonly config: ConfigService,
  ) {}

  private meta(req: Request): RequestMeta {
    return {
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    };
  }

  private isProduction(): boolean {
    return (
      this.config.get<string>('nodeEnv') === 'production' ||
      process.env['COOKIE_SECURE'] === 'true'
    );
  }

  private cookieOptions(maxAgeMs: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction(),
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  private clearCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction(),
      path: '/',
    };
  }

  /**
   * Login is rate limited per IP and verified against timing-safe argon2id.
   * Produces appropriately generic error messages for nonexistent accounts and wrong passwords.
   */
  @Public()
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authClient.request<LoginResult>(AUTH_MESSAGES.LOGIN, {
      email: dto.email,
      password: dto.password,
      meta: this.meta(req),
    });

    const sessionMaxAge = new Date(result.expiresAt).getTime() - Date.now();
    const refreshMaxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    res.cookie(SESSION_COOKIE, result.token, this.cookieOptions(sessionMaxAge));
    if (result.refreshToken) {
      res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions(refreshMaxAge));
    }

    return {
      userId: result.userId,
      activePropertyId: result.activePropertyId,
      expiresAt: result.expiresAt,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  /**
   * Rotates refresh tokens and returns fresh access token.
   * Reusing an already-rotated token triggers reuse detection and revokes the session.
   */
  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = dto.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const result = await this.authClient.request<RefreshResult>(AUTH_MESSAGES.REFRESH, {
      refreshToken: token,
      meta: this.meta(req),
    });

    const accessMaxAge = new Date(result.expiresAt).getTime() - Date.now();
    const refreshMaxAge = 7 * 24 * 60 * 60 * 1000;

    res.cookie(SESSION_COOKIE, result.accessToken, this.cookieOptions(accessMaxAge));
    res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions(refreshMaxAge));

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    };
  }

  /** Revokes the current session and refresh token. */
  @SkipPermissionCheck()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) {
      await this.authClient.request<AckResult>(AUTH_MESSAGES.LOGOUT, { token, meta: this.meta(req) });
    }
    res.clearCookie(SESSION_COOKIE, this.clearCookieOptions());
    res.clearCookie(REFRESH_COOKIE, this.clearCookieOptions());
  }

  /** Revokes all sessions for the user across all instances. */
  @SkipPermissionCheck()
  @HttpCode(204)
  @Post('logout-all')
  async logoutAll(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    await this.authClient.request<AckResult>(AUTH_MESSAGES.LOGOUT_ALL, {
      userId: user.id,
      meta: this.meta(req),
    });

    res.clearCookie(SESSION_COOKIE, this.clearCookieOptions());
    res.clearCookie(REFRESH_COOKIE, this.clearCookieOptions());
  }

  /** Requests a password reset token. Produces a generic response. */
  @Public()
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authClient.request<ForgotPasswordResult>(AUTH_MESSAGES.FORGOT_PASSWORD, {
      email: dto.email,
      meta: this.meta(req),
    });
  }

  /** Consumes a single-use password reset token and sets a new password. */
  @Public()
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authClient.request<ResetPasswordResult>(AUTH_MESSAGES.RESET_PASSWORD, {
      token: dto.token,
      password: dto.password,
      meta: this.meta(req),
    });
  }

  /**
   * Current principal. Requires a session but no domain permission.
   */
  @SkipPermissionCheck()
  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    return this.authClient.request(AUTH_MESSAGES.ME, {
      userId: user.id,
      activePropertyId: user.activePropertyId,
    });
  }

  @SkipPermissionCheck()
  @HttpCode(204)
  @Post('switch-property')
  async switchProperty(
    @Body() dto: SwitchPropertyDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    await this.authClient.request<AckResult>(AUTH_MESSAGES.SWITCH_PROPERTY, {
      userId: user.id,
      sessionId: user.sessionId,
      propertyId: dto.propertyId,
      meta: this.meta(req),
    });
  }
}
