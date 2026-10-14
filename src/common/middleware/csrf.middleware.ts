import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

/** Methods that change state and therefore need cross-site request protection. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cross-site request forgery protection.
 *
 * The session cookie is already `SameSite=Lax`, which stops the browser sending
 * it on a cross-site POST. That is the primary defence and this is the second:
 *
 *  - `SameSite` is evaluated against the registrable domain, so a subdomain of
 *    the deployment origin is "same-site" and would still receive the cookie.
 *    An explicit `Origin` comparison does not care about that.
 *  - `SameSite` is a browser-enforced hint with a patchy history. Checking the
 *    header server-side means the protection does not depend on the browser
 *    honouring it.
 *
 * A request carrying neither `Origin` nor `Referer` is allowed through. Every
 * browser sends `Origin` on cross-origin unsafe requests, so its absence means
 * a non-browser client — curl, the verification suites, a server-to-server
 * call — which has no ambient cookie to abuse in the first place. Rejecting
 * them would break every scripted client for no security gain.
 *
 * Only enforced outside test runs, because the verification suites issue unsafe
 * requests with no `Origin` at all and a deliberately foreign one to prove the
 * rejection path works.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly allowed: Set<string>;

  constructor(config: ConfigService) {
    const raw =
      config.get<string>('frontend.url') ??
      process.env['FRONTEND_URL'] ??
      'http://localhost:5173';
    this.allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (process.env['CSRF_PROTECTION'] === 'false') return next();
    if (!UNSAFE_METHODS.has(req.method)) return next();

    const origin = req.headers['origin'];
    const referer = req.headers['referer'];

    // Prefer Origin: it is the header the browser sets on the request itself and
    // cannot be altered by whatever the Referer was derived from.
    const candidate = Array.isArray(origin) ? origin[0] : origin;
    const source = candidate ?? (Array.isArray(referer) ? referer[0] : referer);

    if (!source) return next();

    let originUrl: string;
    try {
      originUrl = new URL(source).origin;
    } catch {
      throw new ForbiddenException('Cross-site request refused');
    }

    if (!this.allowed.has(originUrl)) {
      throw new ForbiddenException('Cross-site request refused');
    }
    return next();
  }
}