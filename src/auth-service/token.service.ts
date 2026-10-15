import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Session token helpers.
 *
 * Passwords use Argon2id because they are low-entropy human choices and need a
 * deliberately slow, memory-hard KDF. Session tokens are 256 bits of CSPRNG
 * output, so they are already unguessable; hashing them with Argon2 would add
 * latency to every request for no security gain. A fast SHA-256 digest is the
 * correct primitive here and still means a database leak does not expose
 * usable session tokens.
 */
@Injectable()
export class TokenService {
  /** 32 bytes = 256 bits of entropy, URL-safe so it can travel in a cookie. */
  createSessionToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
