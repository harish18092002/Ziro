import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AgentModule } from './agent/agent.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { RazorpayModule } from './razorpay/razorpay.module.js';
import { RedisModule } from './redis/redis.module.js';
import { DemoModule } from './demo/demo.module.js';
import { ReconModule } from './recon/recon.module.js';
import { ReportModule } from './report/report.module.js';
import { ReviewModule } from './review/review.module.js';

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
        AgentModule,
        ReviewModule,
        ReconModule,
        ReportModule,
        DemoModule,
        AuditModule,
      ],
    };
  }
}
