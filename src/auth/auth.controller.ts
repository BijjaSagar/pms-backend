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

/**
 * Login attempts allowed per IP per minute.
 *
 * Environment-driven for the same reason as the global ceiling: the
 * verification suites authenticate as five roles plus every account they
 * create, so back-to-back runs would otherwise be throttled into reporting
 * failures that have nothing to do with the code. The default is the production
 * value of 10; only the test harness raises it, and the security suite
 * deliberately leaves it at the default so it can prove the throttle works.
 */
const LOGIN_RATE_LIMIT = parseInt(process.env['LOGIN_RATE_LIMIT_PER_MINUTE'] ?? '10', 10);
import { Public, SkipPermissionCheck } from '../common/decorators/access.decorator.js';
import { AuthService, SESSION_COOKIE, type RequestMeta } from './auth.service.js';
import { LoginDto, SwitchPropertyDto } from './dto/auth.dto.js';

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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private meta(req: Request): RequestMeta {
    return {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    };
  }

  private cookieOptions(maxAgeMs: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.config.get<string>('nodeEnv') === 'production',
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  /**
   * Login is rate limited per IP. The throttle is the first line of defence
   * against brute force; Argon2id cost is the second.
   *
   * The limit is deliberately not tighter: several staff share one front-desk
   * NAT, so a very low ceiling would let one person's mistyped attempts lock
   * out their colleagues. Per-account lockout is the stronger control and is a
   * later hardening step.
   */
  @Public()
  @Throttle({ default: { limit: LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password, this.meta(req));

    res.cookie(SESSION_COOKIE, result.token, this.cookieOptions(result.expiresAt.getTime() - Date.now()));

    return {
      userId: result.userId,
      activePropertyId: result.activePropertyId,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @SkipPermissionCheck()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await this.auth.logout(token, this.meta(req));
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /**
   * Current principal. Requires a session but no domain permission, so it is
   * marked @SkipPermissionCheck; the guard still enforces authentication and
   * the service re-validates property membership.
   */
  @SkipPermissionCheck()
  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    return this.auth.buildMe(user.id, user.activePropertyId);
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
    await this.auth.switchProperty(user.id, user.sessionId, dto.propertyId, this.meta(req));
  }
}