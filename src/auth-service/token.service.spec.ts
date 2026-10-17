import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service.js';

describe('TokenService - Production Security & JWT Verification', () => {
  const config = new ConfigService({
    jwt: {
      secret: 'super-secure-production-secret-key-at-least-32-chars!',
      audience: 'triponx-pms',
      issuer: 'triponx-auth',
    },
  });

  const tokenService = new TokenService(config);

  it('signs and verifies a valid access token', () => {
    const { token, expiresAt } = tokenService.signAccessToken({
      sub: 'usr-123',
      email: 'admin@dev.local',
      org: 'org-1',
      prop: 'prop-1',
      sid: 'sess-1',
      perms: ['reservation.read'],
      expiresInSeconds: 300,
    });

    expect(token).toBeTypeOf('string');
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const verified = tokenService.verifyAccessToken(token);
    expect(verified.sub).toBe('usr-123');
    expect(verified.email).toBe('admin@dev.local');
    expect(verified.org).toBe('org-1');
    expect(verified.prop).toBe('prop-1');
    expect(verified.sid).toBe('sess-1');
    expect(verified.perms).toEqual(['reservation.read']);
    expect(verified.aud).toBe('triponx-pms');
    expect(verified.iss).toBe('triponx-auth');
  });

  it('rejects expired access tokens', () => {
    const { token } = tokenService.signAccessToken({
      sub: 'usr-123',
      email: 'admin@dev.local',
      org: 'org-1',
      prop: 'prop-1',
      sid: 'sess-1',
      perms: [],
      expiresInSeconds: -10, // Expired in the past
    });

    expect(() => tokenService.verifyAccessToken(token)).toThrow(UnauthorizedException);
    expect(() => tokenService.verifyAccessToken(token)).toThrow(/expired/i);
  });

  it('rejects malformed access tokens', () => {
    // Missing parts
    expect(() => tokenService.verifyAccessToken('not-a-token')).toThrow(UnauthorizedException);
    expect(() => tokenService.verifyAccessToken('header.payload')).toThrow(UnauthorizedException);
    expect(() => tokenService.verifyAccessToken('header.payload.sig.extra')).toThrow(UnauthorizedException);

    // Corrupted base64
    expect(() => tokenService.verifyAccessToken('!!!.@@@.###')).toThrow(UnauthorizedException);
  });

  it('rejects incorrectly signed or tampered access tokens', () => {
    const { token } = tokenService.signAccessToken({
      sub: 'usr-123',
      email: 'admin@dev.local',
      org: 'org-1',
      prop: 'prop-1',
      sid: 'sess-1',
      perms: ['user.read'],
    });

    const [header, payload, sig] = token.split('.');

    // Tampered payload (elevation attempt: change user.read to admin)
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        perms: ['admin'],
      }),
    ).toString('base64url');

    const tamperedToken = `${header}.${tamperedPayload}.${sig}`;
    expect(() => tokenService.verifyAccessToken(tamperedToken)).toThrow(UnauthorizedException);
    expect(() => tokenService.verifyAccessToken(tamperedToken)).toThrow(/signature/i);

    // Completely bogus signature
    const bogusSignatureToken = `${header}.${payload}.${Buffer.from('forged_signature').toString('base64url')}`;
    expect(() => tokenService.verifyAccessToken(bogusSignatureToken)).toThrow(UnauthorizedException);
  });

  it('rejects access tokens with wrong audience', () => {
    const { token } = tokenService.signAccessToken({
      sub: 'usr-123',
      email: 'admin@dev.local',
      org: 'org-1',
      prop: 'prop-1',
      sid: 'sess-1',
      perms: [],
      aud: 'different-audience-or-service',
    });

    expect(() =>
      tokenService.verifyAccessToken(token, { audience: 'triponx-pms' }),
    ).toThrow(UnauthorizedException);
    expect(() =>
      tokenService.verifyAccessToken(token, { audience: 'triponx-pms' }),
    ).toThrow(/audience/i);
  });

  it('rejects tokens signed with unsupported algorithms or alg: none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'usr-123', aud: 'triponx-pms', iss: 'triponx-auth' })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    expect(() => tokenService.verifyAccessToken(noneToken)).toThrow(UnauthorizedException);
    expect(() => tokenService.verifyAccessToken(noneToken)).toThrow(/algorithm/i);
  });

  it('generates high-entropy session, refresh, and reset tokens', () => {
    const sessionToken = tokenService.createSessionToken();
    const refreshToken = tokenService.createRefreshToken();
    const resetToken = tokenService.createPasswordResetToken();

    expect(sessionToken.length).toBeGreaterThanOrEqual(32);
    expect(refreshToken.startsWith('rt_')).toBe(true);
    expect(resetToken.startsWith('prt_')).toBe(true);

    const hash1 = tokenService.hashSessionToken(sessionToken);
    const hash2 = tokenService.hashSessionToken(sessionToken);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });
});
