import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { RazorpayModule } from './razorpay/razorpay.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRoot({
          pinoHttp: { redact: ['req.headers.authorization', 'req.headers.cookie'] },
        }),
        DbModule,
        RedisModule,
        HealthModule,
        RazorpayModule,
        IngestModule,
      ],
    };
  }
}
