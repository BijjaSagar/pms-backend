import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';

/**
 * The gateway's auth surface.
 *
 * The services themselves now live in the auth microservice; this module only
 * contributes the HTTP controller, which reaches them through the global
 * `AuthClientModule`.
 */
@Module({
  controllers: [AuthController],
})
export class AuthModule {}
  