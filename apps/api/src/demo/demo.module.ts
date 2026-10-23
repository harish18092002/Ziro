import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
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
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
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

/** Strangers may ask the server to undo only the one run they were looking at. */
export const resetSchema = z.strictObject({ runId: z.uuid() });

const HOUR = 3_600_000;

type Limits = Pick<
  Env,
  | 'DEMO_LIVE_RUNS_PER_IP_HOUR'
  | 'DEMO_LIVE_RUNS_PER_HOUR'
  | 'DEMO_RUNS_PER_IP_HOUR'
  | 'DEMO_RUNS_PER_HOUR'
>;

/** One rolling hour, `max` calls. Zero refuses everything. */
const perHour = (max: number): RateLimiter => new RateLimiter([{ windowMs: HOUR, max }]);

@Controller()
export class DemoController {
  // Counted in this process: exact with one instance, a speed bump with more. The daily model budget is not
  // counted here; it is summed from the database, so it holds however many instances there are.
  private readonly liveEach: RateLimiter;
  private readonly liveAll: RateLimiter;
  private readonly runsEach: RateLimiter;
  private readonly runsAll: RateLimiter;

  constructor(
    private readonly demo: DemoService,
    @Inject(ENV) env: Limits,
  ) {
    this.liveEach = perHour(env.DEMO_LIVE_RUNS_PER_IP_HOUR);
    this.liveAll = perHour(env.DEMO_LIVE_RUNS_PER_HOUR);
    this.runsEach = perHour(env.DEMO_RUNS_PER_IP_HOUR);
    this.runsAll = perHour(env.DEMO_RUNS_PER_HOUR);
  }

  /**
   * Every limiter is asked first and the call is counted only if all agree, so a refusal by one does not
   * spend another's allowance. A live run is checked against its own, stricter limits before the general ones.
   */
  private admit(live: boolean, ip: string, res: Response): void {
    const asked: [RateLimiter, string, string][] = [
      ...(live
        ? ([
            [this.liveEach, ip, 'live runs are limited per visitor each hour'],
            [this.liveAll, '*', 'live runs are limited for everyone each hour'],
          ] as [RateLimiter, string, string][])
        : []),
      [this.runsEach, ip, 'runs are limited per visitor each hour'],
      [this.runsAll, '*', 'runs are limited for everyone each hour'],
    ];
    for (const [limiter, key, why] of asked) {
      const verdict = limiter.peek(key);
      if (!verdict.ok) {
        res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
        throw new HttpException(
          {
            error: 'too_many_runs',
            message: `${why}; please wait ${verdict.retryAfterSeconds} seconds before starting another run`,
          },
          429,
        );
      }
    }
    for (const [limiter, key] of asked) limiter.check(key);
  }

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
    this.admit(body.agent === 'live', req.ip ?? 'unknown', res);
    return {
      runId: await this.demo.start({ preset: 'demo', agent: body.agent, chaos: body.chaos }),
    };
  }

  /** "Reset demo": archive this run and start a fresh scripted one. Counts as a run for the limits. */
  @Post('demo/reset')
  @HttpCode(202)
  reset(
    @Body(new ZodPipe(resetSchema)) body: { runId: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.admit(false, req.ip ?? 'unknown', res);
    return this.demo.reset(body.runId);
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
