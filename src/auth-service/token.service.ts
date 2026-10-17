import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  org: string;
  prop: string | null;
  sid: string;
  perms: string[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface SignAccessTokenInput {
  sub: string;
  email: string;
  org: string;
  prop: string | null;
  sid: string;
  perms?: string[];
  iss?: string;
  aud?: string;
  expiresInSeconds?: number;
}

export interface VerifyTokenOptions {
  audience?: string;
  issuer?: string;
  ignoreExpiration?: boolean;
}

/**
 * Token helpers for sessions, JWT access tokens, refresh tokens, and password reset.
 *
 * Session tokens are 256 bits of CSPRNG output hashed with SHA-256.
 * Access tokens are HS256-signed JWTs with strict structure, signature, audience,
 * and expiration verification.
 */
@Injectable()
export class TokenService {
  private readonly jwtSecret: string;
  private readonly defaultAudience: string;
  private readonly defaultIssuer: string;

  constructor(private readonly config: ConfigService) {
    this.jwtSecret =
      this.config.get<string>('jwt.secret') ??
      process.env['JWT_SECRET'] ??
      'triponx-dev-jwt-secret-do-not-use-in-production-without-overriding-32chars';
    this.defaultAudience =
      this.config.get<string>('jwt.audience') ??
      process.env['JWT_AUDIENCE'] ??
      'triponx-pms';
    this.defaultIssuer =
      this.config.get<string>('jwt.issuer') ??
      process.env['JWT_ISSUER'] ??
      'triponx-auth';
  }

  /** 32 bytes = 256 bits of entropy, URL-safe so it can travel in a cookie or header. */
  createSessionToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  createRefreshToken(): string {
    return `rt_${randomBytes(32).toString('base64url')}`;
  }

  createPasswordResetToken(): string {
    return `prt_${randomBytes(32).toString('base64url')}`;
  }

  /**
   * Signs a JWT access token with HS256.
   */
  signAccessToken(
    payload: SignAccessTokenInput,
  ): { token: string; expiresAt: Date } {
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = payload.expiresInSeconds ?? 900; // 15 minutes default
    const expSec = nowSec + ttl;

    const fullPayload: AccessTokenPayload = {
      sub: payload.sub,
      email: payload.email,
      org: payload.org,
      prop: payload.prop,
      sid: payload.sid,
      perms: payload.perms ?? [],
      iss: payload.iss ?? this.defaultIssuer,
      aud: payload.aud ?? this.defaultAudience,
      iat: nowSec,
      exp: expSec,
    };

    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const signature = createHmac('sha256', this.jwtSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return {
      token: `${encodedHeader}.${encodedPayload}.${signature}`,
      expiresAt: new Date(expSec * 1000),
    };
  }

  /**
   * Verifies a JWT access token against signature, structure, audience, and expiration.
   * Throws UnauthorizedException on any mismatch or tampering.
   */
  verifyAccessToken(token: string, options?: VerifyTokenOptions): AccessTokenPayload {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Token is required');
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Malformed access token');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // 1. Verify header
    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Malformed access token header');
    }

    if (header.alg !== 'HS256') {
      throw new UnauthorizedException('Unsupported token algorithm');
    }

    // 2. Verify signature
    const expectedSignature = createHmac('sha256', this.jwtSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const actualBuf = Buffer.from(signatureB64, 'utf8');

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new UnauthorizedException('Invalid token signature');
    }

    // 3. Verify payload
    let payload: AccessTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Malformed access token payload');
    }

    if (!payload || typeof payload !== 'object') {
      throw new UnauthorizedException('Malformed access token payload');
    }

    // 4. Verify expiration
    const nowSec = Math.floor(Date.now() / 1000);
    if (!options?.ignoreExpiration && typeof payload.exp === 'number' && payload.exp <= nowSec) {
      throw new UnauthorizedException('Token has expired');
    }

    // 5. Verify audience
    const expectedAudience = options?.audience ?? this.defaultAudience;
    if (expectedAudience && payload.aud !== expectedAudience) {
      throw new UnauthorizedException('Invalid token audience');
    }

    // 6. Verify issuer
    const expectedIssuer = options?.issuer ?? this.defaultIssuer;
    if (expectedIssuer && payload.iss !== expectedIssuer) {
      throw new UnauthorizedException('Invalid token issuer');
    }

    return payload;
  }
}
