import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  type ApproveInput,
  approveSchema,
  type QueueQuery,
  queueQuerySchema,
  type RejectInput,
  rejectSchema,
} from './requests.js';
import { type Decision, ReviewService } from './review.service.js';

/**
 * The human gate. Nothing here authenticates the caller: `reviewer` is a name recorded as given.
 * That is not safe on a public deployment; it needs real authentication first (ADR-012).
 */
@Controller()
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  /** Proposals waiting for a person, largest amount at stake first. */
  @Get('runs/:id/review/queue')
  queue(
    @Param('id', ParseUUIDPipe) runId: string,
    @Query(new ZodPipe(queueQuerySchema)) query: QueueQuery,
  ) {
    return this.review.queue(runId, query);
  }

  /** The run's headline numbers, including how many agent proposals the verifier caught. */
  @Get('runs/:id/review/summary')
  summary(@Param('id', ParseUUIDPipe) runId: string) {
    return this.review.summary(runId);
  }

  /** Verifies any proposals that were stored but not yet verified (a retry hook). */
  @Post('runs/:id/verify')
  @HttpCode(200)
  async verify(@Param('id', ParseUUIDPipe) runId: string) {
    await this.review.summary(runId); // 404 for an unknown run
    return this.review.verifyPending(runId);
  }

  @Get('proposals/:id')
  detail(@Param('id', ParseUUIDPipe) proposalId: string) {
    return this.review.detail(proposalId);
  }

  /** Approving a match creates the match group; the records are verified again first. */
  @Post('proposals/:id/approve')
  @HttpCode(200)
  approve(
    @Param('id', ParseUUIDPipe) proposalId: string,
    @Body(new ZodPipe(approveSchema)) body: ApproveInput,
  ): Promise<Decision> {
    return this.review.approve(proposalId, body);
  }

  /** Rejecting needs a note; the exception goes back to the open list. */
  @Post('proposals/:id/reject')
  @HttpCode(200)
  reject(
    @Param('id', ParseUUIDPipe) proposalId: string,
    @Body(new ZodPipe(rejectSchema)) body: RejectInput,
  ): Promise<Decision> {
    return this.review.reject(proposalId, body);
  }
}
