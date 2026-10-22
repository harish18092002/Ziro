import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { AgentService } from './agent.service.js';
import { INVESTIGATION_QUEUE, type InvestigationQueue } from './queue.js';

/** Optional: one exception instead of every open one. An empty body means "all open exceptions". */
export const investigateSchema = z
  .strictObject({ exceptionId: z.uuid().optional() })
  .optional()
  .transform((body) => body ?? {});

const SKIPPED_EXAMPLES = 20;

export interface InvestigateResponse {
  readonly runId: string;
  /** Exceptions that will be investigated. */
  readonly exceptions: number;
  readonly jobs: number;
  /** Left out because there is nothing for the agent to look at; a person triages these as a list. */
  readonly skipped: {
    readonly count: number;
    readonly examples: { exceptionId: string; why: string }[];
  };
}

@Controller('runs')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    @Inject(INVESTIGATION_QUEUE) private readonly queue: InvestigationQueue,
  ) {}

  /**
   * Queues the open exceptions of a run (or just one) for investigation. Returns at once: the work
   * happens in the background and its results are stored as proposals. An exception that already has
   * a proposal is no longer open, so asking twice does not spend twice.
   */
  @Post(':id/investigate')
  @HttpCode(202)
  async investigate(
    @Param('id', ParseUUIDPipe) runId: string,
    @Body(new ZodPipe(investigateSchema)) body: { exceptionId?: string },
  ): Promise<InvestigateResponse> {
    if (!this.agent.configured) {
      throw new ServiceUnavailableException(
        'the investigation agent needs ANTHROPIC_API_KEY to be set',
      );
    }
    const plan = await this.agent.plan(runId, body.exceptionId);
    await this.queue.enqueue(plan.jobs);
    return {
      runId,
      exceptions: plan.exceptions,
      jobs: plan.jobs.length,
      skipped: { count: plan.skipped.length, examples: plan.skipped.slice(0, SKIPPED_EXAMPLES) },
    };
  }
}
