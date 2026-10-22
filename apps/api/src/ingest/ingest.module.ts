import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DbModule } from '../db/db.module.js';
import { RazorpayModule } from '../razorpay/razorpay.module.js';
import { IngestService } from './ingest.service.js';
import { RunsController } from './runs.controller.js';

@Module({
  imports: [
    DbModule,
    RazorpayModule,
    // Uploads are held in memory, so the size cap is the memory bound: IMPORT_MAX_BYTES per file,
    // one file per request, and no stray fields. Exceeding it is answered 413 by Nest.
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        limits: { fileSize: env.IMPORT_MAX_BYTES, files: 1, fields: 4, parts: 6 },
      }),
    }),
  ],
  controllers: [RunsController],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
