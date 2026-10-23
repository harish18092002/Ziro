import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AgentModule } from '../agent/agent.module.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DbModule } from '../db/db.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { ReconModule } from '../recon/recon.module.js';
import { ReviewModule } from '../review/review.module.js';
import { DemoService } from './demo.service.js';
import { RateLimiter } from './rate-limit.js';

/** Strangers choose only the agent; the dataset is always the 50-order demo. */
export const startSchema = z
  .strictObject({
    agent: z.enum(['scripted', 'live']).default('scripted'),
    /** Inject two model failures to show them handled; DEMO_MODE only (the service refuses otherwise). */
    chaos: z.boolean().default(false),
  })
  .optional()
  .transform((body) => body ?? { agent: 'scripted' as const, chaos: false });

const MINUTE = 60_000;
/** Per client: 5 runs in 10 minutes. Everyone together: 60 in an hour. A speed bump, not a wall. */
const perClient = new RateLimiter([{ windowMs: 10 * MINUTE, max: 5 }]);
const everyone = new RateLimiter([{ windowMs: 60 * MINUTE, max: 60 }]);

@Controller()
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  /** What the home page may offer: the featured runs, and whether a live model can be used. */
  @Get('demo')
  availability() {
    return this.demo.availability();
  }

  /** Starts a demo run and returns its id as soon as the data is in; the rest happens in the background. */
  @Post('demo/runs')
  @HttpCode(202)
  async start(
    @Body(new ZodPipe(startSchema)) body: { agent: 'scripted' | 'live'; chaos: boolean },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    for (const [limiter, key] of [
      [perClient, req.ip ?? 'unknown'],
      [everyone, '*'],
    ] as const) {
      const verdict = limiter.check(key);
      if (!verdict.ok) {
        res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
        throw new HttpException(
          {
            error: 'too_many_runs',
            message: `please wait ${verdict.retryAfterSeconds} seconds before starting another run`,
          },
          429,
        );
      }
    }
    return {
      runId: await this.demo.start({ preset: 'demo', agent: body.agent, chaos: body.chaos }),
    };
  }

  @Get('runs/:id/progress')
  progress(@Param('id', ParseUUIDPipe) runId: string) {
    return this.demo.progress(runId);
  }
}

@Module({
  imports: [DbModule, IngestModule, ReconModule, ReviewModule, AgentModule],
  controllers: [DemoController],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
