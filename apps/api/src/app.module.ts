import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AgentModule } from './agent/agent.module.js';
import { loggerParams } from './common/logging.js';
import { AdminGuard } from './auth/admin.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { RazorpayModule } from './razorpay/razorpay.module.js';
import { RedisModule } from './redis/redis.module.js';
import { DemoModeGuard } from './demo/demo-mode.guard.js';
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
        LoggerModule.forRoot(loggerParams(env)),
        DbModule,
        RedisModule,
        HealthModule,
        AuthModule,
        RazorpayModule,
        IngestModule,
        AgentModule,
        ReviewModule,
        ReconModule,
        ReportModule,
        DemoModule,
        AuditModule,
      ],
      providers: [
        // The admin token, when one is set (auth/admin.guard.ts), then default-deny on the public demo
        // (demo/demo-mode.guard.ts). They never both apply: a token and DEMO_MODE together refuse to boot.
        { provide: APP_GUARD, useClass: AdminGuard },
        { provide: APP_GUARD, useClass: DemoModeGuard },
      ],
    };
  }
}
