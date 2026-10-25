// Turns exceptions into stored, audited proposals. The harness (an AgentRunner) does the thinking;
// everything around it is here: which exceptions to investigate, whether a model call is allowed at
// all (kill switch, daily budget), logging every call, and writing the result once.
//
// Idempotency: the real guard is the unique index on agent_proposals (exception_id, attempt). A job
// that runs twice, or two workers that pick up the same exception, store one proposal and spend at
// most one extra investigation, and `process` skips work that is already on record before it starts.
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type RecordRef, recordRefSchema } from '@ziro/core/domain';
import { bigintJsonReplacer } from '@ziro/core/domain';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { auditStep } from '../audit/audit.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import { agentProposals, llmCalls, reconExceptions, reconRuns } from '../db/schema.js';
import { deterministicUuid } from '../razorpay/identity.js';
import { PROPOSAL_PIPELINE, type ProposalPipeline } from '../review/pipeline.js';
import { DEGRADED_LABEL } from './degraded.js';
import { type InvestigationJob } from './jobs.js';
import type { BuiltRouter, Dropped } from '../llm/factory.js';
import { formatMicroUsd, parseMicroUsd } from '../llm/pricing.js';
import type { Attempt, SlotStatus } from '../llm/router.js';
import { cluster, type Skipped, triage } from './triage.js';
import { Toolbox } from './tools/toolbox.js';
import {
  AgentHalted,
  type AgentRunner,
  type ExceptionToInvestigate,
  type HarnessName,
  HALT_MESSAGE,
  type HaltReason,
  type InvestigationContext,
  type ProposalDraft,
} from './types.js';

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');
export const LLM_ROUTER = Symbol('LLM_ROUTER');

/** Whether the agent will take work right now, and if not, why. Shown as a banner. */
export interface AgentStatus {
  readonly configured: boolean;
  /** Stopped by an operator switch: the kill switch or the daily budget. */
  readonly paused: {
    readonly reason: HaltReason;
    readonly message: string;
    readonly since: string | null;
    readonly until: string | null;
  } | null;
  readonly spentTodayUsd: string;
  readonly dailyBudgetUsd: string;
  /** Each model in the chain: usable, cooling, out of quota until a time, or switched off. */
  readonly models: readonly SlotStatus[];
  /** Models left out at boot (no key, no price) and why. */
  readonly dropped: readonly Dropped[];
  /**
   * True when a chain is configured and no model in it can answer right now. New exceptions go to a
   * person with the reason "AI quota exhausted"; the rules keep running.
   */
  readonly exhausted: boolean;
  /** How answers are obtained: live, recorded as they come, or replayed from a record. */
  readonly cache: Env['LLM_CACHE'];
  readonly tier: Env['GEMINI_TIER'];
}

/** The model-layer fields are optional: a test of the agent without a model layer has none (off, free). */
export type AgentSettings = Pick<
  Env,
  'AGENT_KILL_SWITCH' | 'DAILY_LLM_BUDGET_USD' | 'CLUSTER_EXCEPTIONS'
> &
  Partial<Pick<Env, 'LLM_CACHE' | 'GEMINI_TIER'>>;

export interface Plan {
  readonly runId: string;
  readonly jobs: InvestigationJob[];
  readonly exceptions: number;
  readonly skipped: Skipped[];
}

export interface ProcessResult {
  /** Proposals written by this job. */
  readonly stored: number;
  /** Exceptions that already had a proposal for this attempt: nothing was spent on them. */
  readonly alreadyDone: number;
  /** Exceptions that are no longer open (a person got there first, or it was dismissed). */
  readonly notOpen: number;
}

const MICRO = 1_000_000;
const DAY_MS = 86_400_000;
const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

@Injectable()
export class AgentService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(ENV) private readonly settings: AgentSettings,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner | null,
    /** Verifies and routes what is stored. Absent in tests of the agent alone. */
    @Optional()
    @Inject(PROPOSAL_PIPELINE)
    private readonly pipeline: ProposalPipeline | null = null,
    /** The models behind the runner, for the status banner. Absent in tests of the agent alone. */
    @Optional()
    @Inject(LLM_ROUTER)
    private readonly models: BuiltRouter | null = null,
  ) {}

  /** The time source for the daily budget; a test replaces it. */
  clock: () => Date = () => new Date();

  get configured(): boolean {
    return this.runner !== null;
  }

  // --- planning ---------------------------------------------------------------------------------

  /** The jobs that would investigate this run's open exceptions (or one of them), and what is left out. */
  async plan(runId: string, exceptionId?: string): Promise<Plan> {
    const [run] = await this.db
      .select({ id: reconRuns.id })
      .from(reconRuns)
      .where(eq(reconRuns.id, runId));
    if (run === undefined) throw new NotFoundException('no such run');

    const rows = await this.db
      .select()
      .from(reconExceptions)
      .where(
        exceptionId === undefined
          ? and(eq(reconExceptions.runId, runId), eq(reconExceptions.status, 'open'))
          : and(eq(reconExceptions.runId, runId), eq(reconExceptions.id, exceptionId)),
      );
    if (exceptionId !== undefined) {
      const [only] = rows;
      if (only === undefined) throw new NotFoundException('no such exception in this run');
      if (only.status !== 'open')
        throw new ConflictException(`the exception is ${only.status}, not open`);
    }

    const attempts = await this.latestAttempts(runId);
    // "All open exceptions" does not include one that was already investigated (its proposal was rejected,
    // say): running it again costs money, so it has to be asked for by id.
    const already: Skipped[] = [];
    const wanted =
      exceptionId === undefined
        ? rows.filter((r) => {
            if (!attempts.has(r.id)) return true;
            already.push({
              exceptionId: r.id,
              why: 'already investigated; ask for it by id to run it again',
            });
            return false;
          })
        : rows;
    const items = wanted.map((r) => ({
      id: r.id,
      cause: r.cause,
      subject: { recordType: r.subjectType, recordId: r.subjectId } satisfies RecordRef,
      candidates: candidatesOf(r.candidates),
    }));
    const { investigate, skipped } = triage(items);
    const groups = this.settings.CLUSTER_EXCEPTIONS
      ? cluster(investigate)
      : investigate.map((e) => [e]);

    const jobs = groups.map((group): InvestigationJob => {
      const members = group.map((e) => ({
        exceptionId: e.id,
        attempt: (attempts.get(e.id) ?? 0) + 1,
      }));
      return {
        runId,
        clusterId:
          group.length > 1
            ? deterministicUuid(
                runId,
                'investigation_cluster',
                members.map((m) => `${m.exceptionId}:${m.attempt}`).join(','),
              )
            : null,
        items: members,
      };
    });
    return { runId, jobs, exceptions: investigate.length, skipped: [...skipped, ...already] };
  }

  /** The latest attempt per exception, by run: one query however many exceptions, no id list. */
  private async latestAttempts(runId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        id: agentProposals.exceptionId,
        attempt: sql<number>`max(${agentProposals.attempt})`.mapWith(Number),
      })
      .from(agentProposals)
      .where(eq(agentProposals.runId, runId))
      .groupBy(agentProposals.exceptionId);
    return new Map(rows.map((r) => [r.id, r.attempt]));
  }

  // --- the gate --------------------------------------------------------------------------------------

  /** Today's LLM spend (UTC day), in micro-USD. */
  async spentToday(): Promise<bigint> {
    const start = startOfUtcDay(this.clock());
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text` })
      .from(llmCalls)
      .where(
        and(
          gte(llmCalls.createdAt, start),
          lt(llmCalls.createdAt, new Date(start.getTime() + DAY_MS)),
        ),
      );
    return parseMicroUsd(row?.total ?? '0');
  }

  /**
   * Called before every model request. The budget is checked against calls already on record, so
   * requests in flight at the same moment can overshoot it by their own cost: with the worker's
   * concurrency limit, a small and bounded amount.
   */
  async gate(): Promise<void> {
    if (this.settings.AGENT_KILL_SWITCH) throw new AgentHalted('kill_switch');
    const budget = BigInt(Math.round(this.settings.DAILY_LLM_BUDGET_USD * MICRO));
    if ((await this.spentToday()) >= budget) throw new AgentHalted('daily_budget');
  }

  /**
   * Whether the agent will take work, for the banner. The two operator switches come first, then the state
   * of each model. Rules never depend on this: they run whether or not the agent can answer.
   */
  async status(): Promise<AgentStatus> {
    const budget = BigInt(Math.round(this.settings.DAILY_LLM_BUDGET_USD * MICRO));
    const spent = await this.spentToday();
    const halted = (reason: HaltReason) => ({
      reason,
      message: HALT_MESSAGE[reason],
      since: null,
      until: null,
    });
    const models = (await this.models?.router?.status()) ?? [];
    return {
      configured: this.configured,
      paused: this.settings.AGENT_KILL_SWITCH
        ? halted('kill_switch')
        : spent >= budget
          ? halted('daily_budget')
          : null,
      spentTodayUsd: formatMicroUsd(spent),
      dailyBudgetUsd: formatMicroUsd(budget),
      models,
      dropped: this.models?.dropped ?? [],
      exhausted: models.length > 0 && models.every((m) => m.state !== 'ok'),
      cache: this.settings.LLM_CACHE ?? 'off',
      tier: this.settings.GEMINI_TIER ?? 'free',
    };
  }

  private async recordLlmCall(runId: string, attempt: Attempt): Promise<string> {
    const usage = attempt.result?.usage;
    const [row] = await this.db
      .insert(llmCalls)
      .values({
        runId,
        exceptionId: attempt.meta.exceptionId,
        model: attempt.model,
        provider: attempt.provider,
        // A text column in the database, a fixed set in the harnesses.
        harness: attempt.meta.harness as HarnessName,
        tokensIn: usage?.inputTokens ?? 0,
        // Thinking is billed as output, and the estimate counts it so; the column holds both.
        tokensOut: (usage?.outputTokens ?? 0) + (usage?.thoughtTokens ?? 0),
        costUsd: formatMicroUsd(attempt.costMicroUsd),
        estCostUsd:
          attempt.estCostMicroUsd === null ? null : formatMicroUsd(attempt.estCostMicroUsd),
        latencyMs: attempt.latencyMs,
        promptHash: attempt.meta.promptHash,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        stopReason: attempt.result?.stopReason ?? null,
        requestId: attempt.result?.requestId ?? null,
        outcome: attempt.outcome,
        errorKind: attempt.errorKind,
        cached: attempt.cached,
      })
      .returning({ id: llmCalls.id });
    if (row === undefined) throw new Error('llm_calls insert returned nothing');
    return row.id;
  }

  // --- doing the work ----------------------------------------------------------------------------------

  async process(job: InvestigationJob): Promise<ProcessResult> {
    if (this.runner === null)
      throw new ServiceUnavailableException('the investigation agent is not configured');
    const ids = job.items.map((i) => i.exceptionId);

    const rows = await this.db
      .select()
      .from(reconExceptions)
      .where(and(eq(reconExceptions.runId, job.runId), inArray(reconExceptions.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const stored = await this.db
      .select({ id: agentProposals.exceptionId, attempt: agentProposals.attempt })
      .from(agentProposals)
      .where(inArray(agentProposals.exceptionId, ids));
    const done = new Set(stored.map((s) => `${s.id}:${s.attempt}`));

    let alreadyDone = 0;
    let notOpen = 0;
    const members: {
      item: InvestigationJob['items'][number];
      exception: ExceptionToInvestigate;
    }[] = [];
    for (const item of job.items) {
      const row = byId.get(item.exceptionId);
      if (done.has(`${item.exceptionId}:${item.attempt}`)) alreadyDone += 1;
      else if (row === undefined || row.status !== 'open') notOpen += 1;
      else members.push({ item, exception: { id: row.id, ruleReasonCode: row.reasonCode } });
    }
    if (members.length === 0) {
      await this.verifyPending(ids);
      return { stored: 0, alreadyDone, notOpen };
    }

    const ctx: InvestigationContext = {
      runId: job.runId,
      toolbox: await Toolbox.create(this.db, job.runId),
      gate: () => this.gate(),
      recordLlmCall: (attempt) => this.recordLlmCall(job.runId, attempt),
    };
    const drafts = await this.runner.investigate(
      members.map((m) => m.exception),
      ctx,
    );
    if (
      drafts.length !== members.length ||
      drafts.some((d, i) => d.content.exceptionId !== members[i]?.exception.id)
    ) {
      throw new Error('the harness returned drafts that do not match the exceptions it was given');
    }

    const written = await this.store(
      job,
      members.map((m) => m.item),
      drafts,
    );
    await this.verifyPending(ids);
    return { stored: written, alreadyDone, notOpen };
  }

  /**
   * Verifies and routes any proposals of these exceptions that are still pending. Idempotent, and it also
   * picks up a proposal stored by an earlier attempt of the job that failed before verifying it.
   */
  private async verifyPending(exceptionIds: readonly string[]): Promise<void> {
    if (this.pipeline === null) return;
    await this.pipeline.verifyAndRoute(await this.pipeline.pendingFor(exceptionIds));
  }

  /** Writes the proposals, moves each exception to `proposed`, and audits both, in one transaction. */
  private async store(
    job: InvestigationJob,
    items: readonly InvestigationJob['items'][number][],
    drafts: readonly ProposalDraft[],
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const subjects = new Map(
        (
          await tx
            .select()
            .from(reconExceptions)
            .where(
              inArray(
                reconExceptions.id,
                drafts.map((d) => d.content.exceptionId),
              ),
            )
        ).map((e): [string, RecordRef] => [
          e.id,
          { recordType: e.subjectType, recordId: e.subjectId },
        ]),
      );
      let written = 0;
      for (const [i, draft] of drafts.entries()) {
        const item = items[i];
        if (item === undefined) continue;
        const c = draft.content;
        const [row] = await tx
          .insert(agentProposals)
          .values({
            runId: job.runId,
            exceptionId: c.exceptionId,
            llmCallId: draft.llmCallId,
            attempt: item.attempt,
            clusterId: job.clusterId,
            model: draft.model,
            provider: draft.provider ?? null,
            verdict: c.verdict,
            reasonCode: c.reasonCode,
            links: c.links,
            explanation: c.explanation,
            evidence: JSON.parse(JSON.stringify(c.evidence, bigintJsonReplacer)) as never,
            confidencePermille: Math.round(c.confidence * 1000),
            suggestedAction: c.suggestedAction,
            draftJournalEntry:
              c.draftJournalEntry === null
                ? null
                : (JSON.parse(JSON.stringify(c.draftJournalEntry, bigintJsonReplacer)) as never),
            harnessFindings: draft.harnessFindings,
            degraded: draft.degraded ?? null,
          })
          .onConflictDoNothing({ target: [agentProposals.exceptionId, agentProposals.attempt] })
          .returning({ id: agentProposals.id });
        // Someone else stored this attempt first: their proposal stands and nothing more is written.
        if (row === undefined) continue;
        written += 1;

        await tx
          .update(reconExceptions)
          .set({ status: 'proposed' })
          .where(and(eq(reconExceptions.id, c.exceptionId), eq(reconExceptions.status, 'open')));
        const subject = subjects.get(c.exceptionId);
        await auditStep(tx, {
          runId: job.runId,
          actor: 'agent',
          action: 'agent.propose',
          entity: { type: 'agent_proposal', id: row.id },
          before: { exceptionStatus: 'open' },
          // The reason is written here, not taken from the model: audit text is never model text.
          reason:
            draft.degraded == null
              ? `proposed ${c.verdict} (${c.reasonCode}) at ${Math.round(c.confidence * 1000) / 1000} confidence`
              : `handed to a person without a conclusion: ${DEGRADED_LABEL[draft.degraded]}`,
          records: [...c.links, ...(subject ? [subject] : [])],
          after: {
            exceptionStatus: 'proposed',
            exceptionId: c.exceptionId,
            attempt: item.attempt,
            clusterId: job.clusterId,
            verdict: c.verdict,
            reasonCode: c.reasonCode,
            suggestedAction: c.suggestedAction,
            confidencePermille: Math.round(c.confidence * 1000),
            model: draft.model,
            provider: draft.provider ?? null,
            harness: this.runner?.harness,
            llmCallId: draft.llmCallId,
            harnessFindings: draft.harnessFindings.length,
            degraded: draft.degraded ?? null,
            links: c.links.length,
          },
        });
      }
      return written;
    });
  }
}

/** The stored candidates, tolerant of a malformed row: an unreadable list is treated as none. */
function candidatesOf(value: unknown): RecordRef[] {
  const parsed = recordRefSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}
