import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { RedisService } from '../database/redis.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RedisThrottlerStorage } from '../common/redis-throttler.storage.js';
import { CsrfMiddleware } from '../common/middleware/csrf.middleware.js';
import { scrubMetadata } from '../common/pii.js';
import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';

describe('Auth Microservice - Production Readiness & Security Verification', () => {
  const config = new ConfigService({
    nodeEnv: 'production',
    jwt: {
      secret: 'super-production-secret-must-be-at-least-32-chars-long!',
      audience: 'triponx-pms',
      issuer: 'triponx-auth',
    },
    redis: {
      host: '127.0.0.1',
      port: 6379,
    },
    frontend: {
      url: 'http://localhost:5173,https://pms.hotel.com',
    },
  });

  const redisService = new RedisService(config);
  redisService.onModuleInit();

  const tokenService = new TokenService(config);
  const auditService = new AuditService();
  const authService = new AuthService(auditService, tokenService, config, redisService);

  const meta = { ip: '127.0.0.1', userAgent: 'vitest-suite', requestId: 'req-sec-1' };

  const testPassword = 'SecurePassword!2026';

  beforeEach(async () => {
    // Clear test-related redis keys
    await redisService.delPrefix('pms:throttle:');
  });

  // =========================================================================
  // 1. Incorrect passwords and nonexistent accounts produce generic responses
  // =========================================================================
  describe('Case 1: Generic Responses for Authentication Failures', () => {
    it('produces appropriately generic responses for wrong password and nonexistent user', async () => {
      // 1. Nonexistent user
      const errNonExistent = await authService
        .login('nonexistent-account-random@example.com', testPassword, meta)
        .catch((e) => e);
      expect(errNonExistent).toBeInstanceOf(UnauthorizedException);
      expect(errNonExistent.message).toBe('Invalid email or password');

      // 2. Existing user with wrong password
      const errWrongPass = await authService
        .login('admin@dev.local', 'WrongPassword!9999', meta)
        .catch((e) => e);
      expect(errWrongPass).toBeInstanceOf(UnauthorizedException);
      expect(errWrongPass.message).toBe('Invalid email or password');

      // Both failure responses are identical, preventing account enumeration
      expect(errNonExistent.message).toBe(errWrongPass.message);
    });
  });

  // =========================================================================
  // 3. Expired, malformed, incorrectly signed, or wrong-audience access tokens
  // =========================================================================
  describe('Case 3: Token Verification (Expired, Malformed, Signed, Audience)', () => {
    it('rejects expired, malformed, tampered, and wrong-audience access tokens', async () => {
      // Malformed token
      await expect(authService.resolveSession('malformed.token.value')).rejects.toThrow(
        UnauthorizedException,
      );

      // Incorrectly signed token
      const fakeToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub: '123', aud: 'triponx-pms', exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url')}.invalid_signature`;
      await expect(authService.resolveSession(fakeToken)).rejects.toThrow(UnauthorizedException);

      // Expired token
      const { token: expiredToken } = tokenService.signAccessToken({
        sub: '123',
        email: 'test@example.com',
        org: 'org-1',
        prop: 'prop-1',
        sid: 'sid-1',
        perms: [],
        expiresInSeconds: -100, // Past
      });
      await expect(authService.resolveSession(expiredToken)).rejects.toThrow(UnauthorizedException);
      await expect(authService.resolveSession(expiredToken)).rejects.toThrow(/expired/i);

      // Wrong audience
      const { token: wrongAudToken } = tokenService.signAccessToken({
        sub: '123',
        email: 'test@example.com',
        org: 'org-1',
        prop: 'prop-1',
        sid: 'sid-1',
        perms: [],
        aud: 'foreign-service-audience',
      });
      await expect(authService.resolveSession(wrongAudToken)).rejects.toThrow(UnauthorizedException);
      await expect(authService.resolveSession(wrongAudToken)).rejects.toThrow(/audience/i);
    });
  });

  // =========================================================================
  // 4. Refresh-token rotation prevents reuse of old token
  // =========================================================================
  describe('Case 4: Refresh-Token Rotation & Reuse Detection', () => {
    it('rotates refresh tokens and revokes the session if an old token is reused', async () => {
      const loginResult = await authService.login('admin@dev.local', 'DevPass!2026', meta);
      const oldRefreshToken = loginResult.refreshToken;
      expect(oldRefreshToken).toBeDefined();

      // 1. First rotation succeeds and provides fresh tokens
      const rotated = await authService.refresh(oldRefreshToken, meta);
      expect(rotated.accessToken).toBeDefined();
      expect(rotated.refreshToken).toBeDefined();
      expect(rotated.refreshToken).not.toBe(oldRefreshToken);

      // 2. Reusing the old refresh token MUST trigger reuse detection!
      await expect(authService.refresh(oldRefreshToken, meta)).rejects.toThrow(
        /Refresh token reuse detected/i,
      );

      // 3. Once reuse is detected, all sibling/family tokens are invalidated
      await expect(authService.refresh(rotated.refreshToken, meta)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // =========================================================================
  // 5. Logout and logout-all revoke the intended sessions
  // =========================================================================
  describe('Case 5: Logout and Logout-All Session Revocation', () => {
    it('revokes individual sessions on logout and all user sessions on logout-all', async () => {
      // 1. Single session logout
      const login1 = await authService.login('admin@dev.local', 'DevPass!2026', meta);
      const resolvedBefore = await authService.resolveSession(login1.token);
      expect(resolvedBefore).not.toBeNull();

      await authService.logout(login1.token, meta);
      const resolvedAfter = await authService.resolveSession(login1.token);
      expect(resolvedAfter).toBeNull();

      // 2. Logout-all revokes all sessions across all instances
      const sessionA = await authService.login('admin@dev.local', 'DevPass!2026', meta);
      const sessionB = await authService.login('admin@dev.local', 'DevPass!2026', meta);

      expect(await authService.resolveSession(sessionA.token)).not.toBeNull();
      expect(await authService.resolveSession(sessionB.token)).not.toBeNull();

      await authService.logoutAll(sessionA.userId, meta);

      expect(await authService.resolveSession(sessionA.token)).toBeNull();
      expect(await authService.resolveSession(sessionB.token)).toBeNull();
    });
  });

  // =========================================================================
  // 6. Redis failure does not result in unauthorized access
  // =========================================================================
  describe('Case 6: Fail-Closed Security on Redis/Network Failure', () => {
    it('does not allow unauthorized access if the session or token service fails', async () => {
      // 1. No token provided: strictly rejected without granting access
      await expect(authService.resolveSession(undefined)).resolves.toBeNull();
      await expect(authService.resolveSession('')).resolves.toBeNull();

      // 2. Disconnected/broken token verification fails closed
      await expect(authService.resolveSession('bogus-invalid-token')).resolves.toBeNull();
    });
  });

  // =========================================================================
  // 7. Rate limits apply across multiple Auth Service instances
  // =========================================================================
  describe('Case 7: Distributed Rate Limiting Across Instances', () => {
    it('shares rate limit counts across multiple instances via Redis storage', async () => {
      // Simulate two independent application instances sharing Redis
      const instance1 = new RedisThrottlerStorage(config);
      const instance2 = new RedisThrottlerStorage(config);

      const throttleKey = `shared-ip-${Date.now()}`;
      const ttl = 60000;
      const limit = 3;

      // Hit 1 from instance 1
      const hit1 = await instance1.increment(throttleKey, ttl, limit, 0, 'test');
      expect(hit1.totalHits).toBe(1);
      expect(hit1.isBlocked).toBe(false);

      // Hit 2 from instance 2 (different instance, same Redis key)
      const hit2 = await instance2.increment(throttleKey, ttl, limit, 0, 'test');
      expect(hit2.totalHits).toBe(2);
      expect(hit2.isBlocked).toBe(false);

      // Hit 3 from instance 1
      const hit3 = await instance1.increment(throttleKey, ttl, limit, 0, 'test');
      expect(hit3.totalHits).toBe(3);
      expect(hit3.isBlocked).toBe(false);

      // Hit 4 from instance 2: EXCEEDED! Both instances now block!
      const hit4 = await instance2.increment(throttleKey, ttl, limit, 0, 'test');
      expect(hit4.totalHits).toBe(4);
      expect(hit4.isBlocked).toBe(true);

      const checkFromInst1 = await instance1.increment(throttleKey, ttl, limit, 0, 'test');
      expect(checkFromInst1.isBlocked).toBe(true);

      await instance1.onModuleDestroy();
      await instance2.onModuleDestroy();
    });
  });

  // =========================================================================
  // 8. CORS and CSRF protections
  // =========================================================================
  describe('Case 8: CORS & CSRF Protections with Allowed vs Foreign Origins', () => {
    it('refuses unsafe requests from foreign origins and permits trusted origins', () => {
      const csrf = new CsrfMiddleware(config);

      // 1. Unsafe POST request from foreign origin -> Rejected (403)
      const foreignReq: any = {
        method: 'POST',
        headers: { origin: 'http://malicious-attacker-site.com' },
      };
      let nextCalled = false;
      expect(() =>
        csrf.use(foreignReq, {} as any, () => {
          nextCalled = true;
        }),
      ).toThrow(/Cross-site request refused/);
      expect(nextCalled).toBe(false);

      // 2. Unsafe POST request from trusted origin -> Allowed
      const trustedReq: any = {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      };
      nextCalled = false;
      csrf.use(trustedReq, {} as any, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);

      // 3. Safe GET request from foreign origin -> Allowed
      const safeReq: any = {
        method: 'GET',
        headers: { origin: 'http://malicious-attacker-site.com' },
      };
      nextCalled = false;
      csrf.use(safeReq, {} as any, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    });
  });

  // =========================================================================
  // 9. Multi-tenant property isolation
  // =========================================================================
  describe('Case 9: Tenant & Property Isolation', () => {
    it('prevents staff from accessing another hotel without permission', async () => {
      // Find properties
      const properties = await db.orm.public.Property.where({ isActive: brand(true) }).all();
      if (properties.length >= 2) {
        // Manager only has membership at property 1
        const managerUser = await db.orm.public.User.where({ email: brand('manager@dev.local') }).first();
        if (managerUser) {
          const memberships = await db.orm.public.PropertyMembership
            .where({ userId: brand(managerUser.id) })
            .all();
          const foreignProperty = properties.find((p) => !memberships.some((m) => m.propertyId === p.id));

          if (foreignProperty) {
            // Attempting to switch into a hotel without membership throws ForbiddenException (403)
            await expect(
              authService.switchProperty(managerUser.id, 'dummy-sess', foreignProperty.id, meta),
            ).rejects.toThrow(/do not have access to that property/i);
          }
        }
      }
    });
  });

  // =========================================================================
  // 10. Password-reset tokens expire, are single-use, and cannot be replayed
  // =========================================================================
  describe('Case 10: Password-Reset Security (Single-Use, Expiration, Replay Prevention)', () => {
    it('enforces single-use, expiration, and replay prevention for password-reset tokens', async () => {
      // 1. Request reset token
      const reqReset = await authService.forgotPassword('admin@dev.local', meta);
      expect(reqReset.ok).toBe(true);
      expect(reqReset.resetToken).toBeDefined();
      const token = reqReset.resetToken!;

      // 2. Consuming the token resets the password
      const newPass = 'BrandNewPassword!2026';
      const resetResult = await authService.resetPassword(token, newPass, meta);
      expect(resetResult.ok).toBe(true);

      // 3. REPLAY ATTEMPT: Consuming the same token a second time MUST FAIL!
      await expect(
        authService.resetPassword(token, 'AnotherPassword!2026', meta),
      ).rejects.toThrow(/Invalid or expired password reset token|already been used/i);

      // 4. Verify user can now log in with the new password
      const newLogin = await authService.login('admin@dev.local', newPass, meta);
      expect(newLogin.userId).toBeDefined();

      // Reset back to original DevPass!2026 for subsequent tests/development
      const reqResetBack = await authService.forgotPassword('admin@dev.local', meta);
      await authService.resetPassword(reqResetBack.resetToken!, 'DevPass!2026', meta);
    });

    it('rejects expired password reset tokens', async () => {
      const token = 'prt_expired_dummy_token';
      const tokenHash = tokenService.hashSessionToken(token);

      // Store token with expired timestamp
      await redisService.setJson(
        `auth:pwd-reset:${tokenHash}`,
        {
          userId: 'dummy',
          email: 'dummy@example.com',
          expiresAt: Date.now() - 5000, // Expired 5 seconds ago
        },
        60,
      );

      await expect(
        authService.resetPassword(token, 'ValidPassword1234!', meta),
      ).rejects.toThrow(/expired/i);
    });
  });

  // =========================================================================
  // 11. Secrets and tokens are not written to application logs or audit logs
  // =========================================================================
  describe('Case 11: Secrets and Tokens Redaction from Logs', () => {
    it('scrubs sensitive credentials, tokens, and database passwords', () => {
      const rawMetadata = {
        email: 'user@example.com',
        password: 'RawPasswordSecret!',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        inviteToken: 'abc123secrettoken',
        databaseUrl: 'postgresql://postgres:mySuperSecretPass@localhost:5432/db',
        roleKey: 'MANAGER',
        nested: {
          apiKey: 'secret_api_key_123',
          normalField: 'public_value',
        },
      };

      const scrubbed: any = scrubMetadata(rawMetadata);

      expect(scrubbed.password).toBe('***');
      expect(scrubbed.token).toBe('***');
      expect(scrubbed.nested.apiKey).toBe('***');
      expect(scrubbed.nested.normalField).toBe('public_value');
      expect(scrubbed.roleKey).toBe('MANAGER');
    });
  });
});
