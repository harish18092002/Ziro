// What happens when the model API does not behave, for ANY harness (our loop, the Agent SDK, the scripted
// demo agent). It wraps a runner and decides, from the kind of failure (llm.ts: classifyLlmFailure):
//
//   transient   wait with jittered backoff (honouring retry-after) and investigate again, up to the policy;
//               if it never answers, hand the exception to a person (NEEDS_HUMAN, "the model API did not
//               answer") and carry on with the rest. The SDK has already retried each request twice.
//   rejected    the API refused this request (400-class): no retry; NEEDS_HUMAN with the reason.
//   auth        401/403: every call will fail alike. Pause the agent (HALT) instead of degrading each one.
//   sustained   a 429 with no retry-after, or 402: a spend or usage limit. Pause the agent.
//
// and it feeds a circuit breaker: several unavailable outcomes in a row pause the agent too, because the
// next fifty will fail the same way and each would cost a full round of waiting. A pause leaves the
// exception open, so asking again later investigates it.
//
// Anything else that is thrown (a bug, a database error) is not the model's fault and is not hidden: it
// fails the job as it always did.
import { Logger } from '@nestjs/common';
import { type RetryDeps, type RetryPolicy, retrying } from '../common/retry.js';
import type { AgentHealth } from './health.js';
import { LlmError } from './llm.js';
import { draftsFrom, fetchBriefs } from './loop-runner.js';
import {
  type AgentRunner,
  AgentHalted,
  type ExceptionToInvestigate,
  type HarnessName,
  type InvestigationContext,
  type ProposalDraft,
} from './types.js';

/** Three tries in all (the first, then two after waiting), about 2 s then up to 20 s, within 90 s. */
export const DEFAULT_RESILIENCE: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 20_000,
  deadlineMs: 90_000,
};

export interface ResilienceOptions {
  readonly health: AgentHealth;
  readonly policy?: RetryPolicy;
  /** Injected in tests so nothing really waits. */
  readonly deps?: RetryDeps;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export class ResilientRunner implements AgentRunner {
  private readonly log = new Logger('ResilientRunner');

  constructor(
    private readonly inner: AgentRunner,
    private readonly options: ResilienceOptions,
  ) {}

  get harness(): HarnessName {
    return this.inner.harness;
  }

  /** Releases whatever the wrapped runner holds (the Agent SDK's working directory). */
  close(): void {
    (this.inner as { close?: () => void }).close?.();
  }

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const { health } = this.options;
    health.assertRunning();
    const ids = members.map((m) => m.id);
    let attemptsMade = 0;

    try {
      const drafts = await retrying(
        (attempt) => {
          attemptsMade = attempt;
          return this.inner.investigate(members, ctx);
        },
        {
          policy: this.options.policy ?? DEFAULT_RESILIENCE,
          ...(this.options.deps === undefined ? {} : { deps: this.options.deps }),
          isRetryable: (error) => error instanceof LlmError && error.kind === 'transient',
          retryAfterMs: (error) => (error instanceof LlmError ? error.retryAfterMs : null),
          onRetry: (error, attempt, waitMs) =>
            this.log.warn(
              `model API failed (${error instanceof Error ? error.message : String(error)}); try ${attempt + 1} for ${ids.join(',')} in ${waitMs} ms`,
            ),
        },
      );
      health.recordAnswered();
      const retries = attemptsMade - 1;
      return retries === 0
        ? drafts
        : drafts.map((d) => ({
            ...d,
            harnessFindings: [
              `the model API failed ${plural(retries, 'time')} first and then answered`,
              ...d.harnessFindings,
            ],
          }));
    } catch (error) {
      if (error instanceof AgentHalted || !(error instanceof LlmError)) throw error;
      switch (error.kind) {
        case 'auth':
          health.pause('model_auth');
          throw new AgentHalted('model_auth');
        case 'sustained':
          health.pause('provider_limit');
          throw new AgentHalted('provider_limit');
        case 'rejected':
          health.recordAnswered(); // it answered, it just said no
          return this.degrade(members, ctx, 'rejected', describe(error, 'refused the request'));
        case 'transient': {
          health.recordUnavailable();
          return this.degrade(
            members,
            ctx,
            'unavailable',
            describe(error, `did not answer after ${plural(attemptsMade, 'try', 'tries')}`),
          );
        }
      }
    }
  }

  /** NEEDS_HUMAN for every member, with the exception brief attached as the evidence. */
  private async degrade(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
    kind: 'unavailable' | 'rejected',
    reason: string,
  ): Promise<ProposalDraft[]> {
    const { briefCalls } = await fetchBriefs(members, ctx);
    return draftsFrom(
      { end: { kind, reason }, calls: briefCalls, lastLlmCallId: null },
      null,
      members,
    );
  }
}

/** "the model API did not answer after 3 tries (Anthropic API error 529: overloaded, request req_1)". */
function describe(error: LlmError, what: string): string {
  const request = error.requestId === null ? '' : `, request ${error.requestId}`;
  return `the model API ${what} (${error.message}${request})`;
}
