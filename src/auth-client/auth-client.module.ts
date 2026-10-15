import { Global, Module } from '@nestjs/common';
import { AuthClientService } from './auth-client.service.js';

/**
 * Global so the session guard and every controller that needs staff or role
 * data can inject `AuthClientService` without each feature module importing it.
 */
@Global()
@Module({
  providers: [AuthClientService],
  exports: [AuthClientService],
})
export class AuthClientModule {}
