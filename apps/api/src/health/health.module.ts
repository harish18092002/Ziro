import { Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DB, DbModule, type Database } from '../db/db.module.js';
import { REDIS, RedisModule } from '../redis/redis.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { DB_PROBE, type Probe, REDIS_PROBE } from './probe.js';

@Module({
  imports: [DbModule, RedisModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: DB_PROBE,
      inject: [DB],
      useFactory:
        (db: Database): Probe =>
        async () => {
          await db.execute(sql`select 1`);
        },
    },
    {
      provide: REDIS_PROBE,
      inject: [REDIS],
      useFactory:
        (redis: Redis): Probe =>
        async () => {
          await redis.ping();
        },
    },
  ],
})
export class HealthModule {}
