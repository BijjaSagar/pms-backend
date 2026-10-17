import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller.js';
import { AUTH_MESSAGES } from '../contracts/auth.messages.js';
import { SESSION_COOKIE, REFRESH_COOKIE } from '../common/auth.constants.js';

describe('AuthController - Production HTTP Security & Cookies', () => {
  const config = new ConfigService({
    nodeEnv: 'production',
  });

  const mockAuthClient = {
    request: vi.fn(),
  };

  const controller = new AuthController(mockAuthClient as any, config);

  const mockReq: any = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'vitest-agent', 'x-request-id': 'req-123' },
    cookies: {},
  };

  it('sets cookies with HttpOnly, Secure, SameSite=lax, and Path=/', async () => {
    mockAuthClient.request.mockResolvedValueOnce({
      token: 'sess-token-123',
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-123',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      userId: 'usr-1',
      organizationId: 'org-1',
      activePropertyId: 'prop-1',
    });

    const cookiesSet: Record<string, { val: string; opts: any }> = {};
    const mockRes: any = {
      cookie: (name: string, val: string, opts: any) => {
        cookiesSet[name] = { val, opts };
      },
    };

    const res = await controller.login(
      { email: 'admin@dev.local', password: 'DevPass!2026' },
      mockReq,
      mockRes,
    );

    expect(res.userId).toBe('usr-1');
    expect(cookiesSet[SESSION_COOKIE]).toBeDefined();
    expect(cookiesSet[REFRESH_COOKIE]).toBeDefined();

    // Verify session cookie flags
    const sessOpts = cookiesSet[SESSION_COOKIE].opts;
    expect(sessOpts.httpOnly).toBe(true);
    expect(sessOpts.sameSite).toBe('lax');
    expect(sessOpts.secure).toBe(true); // In production
    expect(sessOpts.path).toBe('/');
    expect(sessOpts.maxAge).toBeGreaterThan(0);

    // Verify refresh cookie flags
    const refreshOpts = cookiesSet[REFRESH_COOKIE].opts;
    expect(refreshOpts.httpOnly).toBe(true);
    expect(refreshOpts.sameSite).toBe('lax');
    expect(refreshOpts.secure).toBe(true);
    expect(refreshOpts.path).toBe('/');
  });

  it('clears cookies with proper attributes on logout', async () => {
    mockAuthClient.request.mockResolvedValueOnce({ ok: true });

    const cookiesCleared: Record<string, any> = {};
    const mockRes: any = {
      clearCookie: (name: string, opts: any) => {
        cookiesCleared[name] = opts;
      },
    };

    mockReq.cookies = { [SESSION_COOKIE]: 'sess-token-123' };

    await controller.logout(mockReq, mockRes);

    expect(mockAuthClient.request).toHaveBeenCalledWith(AUTH_MESSAGES.LOGOUT, {
      token: 'sess-token-123',
      meta: { ip: '127.0.0.1', userAgent: 'vitest-agent', requestId: 'req-123' },
    });

    // Check that cookies are cleared with matching path, secure, httpOnly, sameSite
    expect(cookiesCleared[SESSION_COOKIE]).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
    expect(cookiesCleared[REFRESH_COOKIE]).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('clears cookies with proper attributes on logout-all', async () => {
    mockAuthClient.request.mockResolvedValueOnce({ ok: true });

    const cookiesCleared: Record<string, any> = {};
    const mockRes: any = {
      clearCookie: (name: string, opts: any) => {
        cookiesCleared[name] = opts;
      },
    };

    const authedReq: any = {
      ...mockReq,
      user: { id: 'usr-1', organizationId: 'org-1', activePropertyId: null, sessionId: 's-1', permissions: [], isActive: true },
    };

    await controller.logoutAll(authedReq, mockRes);

    expect(mockAuthClient.request).toHaveBeenCalledWith(AUTH_MESSAGES.LOGOUT_ALL, {
      userId: 'usr-1',
      meta: { ip: '127.0.0.1', userAgent: 'vitest-agent', requestId: 'req-123' },
    });

    expect(cookiesCleared[SESSION_COOKIE]).toBeDefined();
    expect(cookiesCleared[REFRESH_COOKIE]).toBeDefined();
  });

  it('supports refresh token rotation through the controller', async () => {
    mockAuthClient.request.mockResolvedValueOnce({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    });

    const cookiesSet: Record<string, { val: string; opts: any }> = {};
    const mockRes: any = {
      cookie: (name: string, val: string, opts: any) => {
        cookiesSet[name] = { val, opts };
      },
    };

    const result = await controller.refresh(
      { refreshToken: 'valid-refresh-token' },
      mockReq,
      mockRes,
    );

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(cookiesSet[SESSION_COOKIE].val).toBe('new-access-token');
    expect(cookiesSet[REFRESH_COOKIE].val).toBe('new-refresh-token');
  });

  it('handles password reset requests and verification', async () => {
    mockAuthClient.request.mockResolvedValueOnce({
      ok: true,
      message: 'If an account with that email exists, password reset instructions have been sent.',
      resetToken: 'prt-123',
    });

    const forgotRes = await controller.forgotPassword(
      { email: 'user@example.com' },
      mockReq,
    );
    expect(forgotRes.ok).toBe(true);

    mockAuthClient.request.mockResolvedValueOnce({
      ok: true,
      message: 'Password has been reset successfully',
    });

    const resetRes = await controller.resetPassword(
      { token: 'prt-123', password: 'NewSecurePassword!2026' },
      mockReq,
    );
    expect(resetRes.ok).toBe(true);
  });
});
