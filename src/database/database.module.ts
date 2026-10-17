import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [DatabaseService, RedisService],
  exports: [DatabaseService, RedisService],
})
export class DatabaseModule {}

