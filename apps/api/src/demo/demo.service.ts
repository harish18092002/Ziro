// One click, the whole loop: generate the data, import it, run the rules, let the agent look at what is
// left, verify what it proposes, and leave the rest in the review queue. The stages run in the
// background; the run itself carries the progress (config.pipeline) and the counts come straight from
// the tables, so a page that polls cannot disagree with the data.
//
// The default agent is the scripted baseline (free, instant, labelled as not a language model). A live
// model is opt-in, only when the server has a key and budget.
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { AgentService, type AgentSettings } from '../agent/agent.service.js';
import { AgentHealth } from '../agent/health.js';
import { ResilientRunner } from '../agent/resilient-runner.js';
import { AgentHalted, type AgentRunner } from '../agent/types.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import { agentProposals, matchGroups, reconExceptions, reconRuns } from '../db/schema.js';
import { IngestService } from '../ingest/ingest.service.js';
import { ReconService } from '../recon/recon.service.js';
import { ReviewService } from '../review/review.service.js';
import { CHAOS_RESILIENCE, type ChaosPlan, ChaosRunner, planChaos } from './chaos-runner.js';
import { type DemoPreset, DEMO_SEED, datasetDir } from './dataset.js';
import { planPlants, ScriptedRunner } from './scripted-runner.js';
import { windowsFor } from './windows.js';

export type AgentChoice = 'scripted' | 'live';
export type Stage = 'matching' | 'investigating' | 'ready' | 'failed';

/** Bump when the pipeline changes in a way old featured runs no longer show; boot then builds a new one. */
export const FEATURED_VERSION = 1;

export interface StartOptions {
  readonly preset: DemoPreset;
  readonly agent: AgentChoice;
  readonly featured?: boolean;
  /** Inject two model failures into the scripted agent to show them handled (DEMO_MODE only). */
  readonly chaos?: boolean;
}

export interface Availability {
  readonly featured: { readonly demo: string | null; readonly eval: string | null };
  readonly scripted: true;
  readonly live: { readonly available: boolean; readonly reason: string | null };
  /** The fault-injection toggle: offered only in DEMO_MODE. */
  readonly chaos: { readonly available: boolean; readonly reason: string | null };
}

export interface Progress {
  readonly runId: string;
  readonly stage: Stage | 'unknown';
  readonly agent: AgentChoice | null;
  readonly preset: DemoPreset | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  /** Exceptions the agent will look at (triage leaves some for a person). Known once matching is done. */
  readonly expected: number | null;
  readonly note: string | null;
  /** The exceptions the demo toggle broke on purpose; null for a run that had no chaos. */
  readonly chaos: ChaosPlan | null;
  readonly counts: {
    readonly groups: number;
    readonly exceptions: number;
    readonly proposals: number;
    readonly verified: number;
    readonly refused: number;
    readonly waiting: number;
  };
}

interface Pipeline {
  stage?: Stage;
  agent?: AgentChoice;
  preset?: DemoPreset;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  expected?: number;
  note?: string;
  chaos?: ChaosPlan;
}

const JOBS_AT_ONCE = 4;
/** What the scripted agent runs under: it never asks a model, so no budget applies. */
const SCRIPTED_SETTINGS: AgentSettings = {
  AGENT_KILL_SWITCH: false,
  DAILY_LLM_BUDGET_USD: 0,
  CLUSTER_EXCEPTIONS: false,
};

@Injectable()
export class DemoService implements OnApplicationBootstrap {
  private readonly log = new Logger('Demo');

  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(ENV) private readonly env: Env,
    private readonly ingest: IngestService,
    private readonly recon: ReconService,
    private readonly review: ReviewService,
    private readonly agent: AgentService,
  ) {}

  /** Builds the featured runs in the background if they are missing, so a visitor never sees an empty site. */
  onApplicationBootstrap(): void {
    if (!this.env.DEMO_SEED_ON_BOOT) return;
    void (async () => {
      for (const preset of ['demo', 'eval'] as const) {
        try {
          if ((await this.featured(preset, true)) === null) {
            await this.start({ preset, agent: 'scripted', featured: true });
          }
        } catch (error) {
          this.log.error(`could not build the featured ${preset} run: ${String(error)}`);
        }
      }
    })();
  }

  // --- what the page may offer --------------------------------------------------------------------------

  async availability(): Promise<Availability> {
    const [demo, evalRun] = await Promise.all([
      this.featured('demo', false),
      this.featured('eval', false),
    ]);
    return {
      featured: { demo, eval: evalRun },
      scripted: true,
      live: await this.liveStatus(),
      chaos: this.chaosStatus(),
    };
  }

  chaosStatus(): { available: boolean; reason: string | null } {
    return this.env.DEMO_MODE
      ? { available: true, reason: null }
      : { available: false, reason: 'the server is not in DEMO_MODE' };
  }

  async liveStatus(): Promise<{ available: boolean; reason: string | null }> {
    if (!this.agent.configured)
      return { available: false, reason: 'the server has no ANTHROPIC_API_KEY' };
    if (this.env.AGENT_KILL_SWITCH) return { available: false, reason: 'the kill switch is on' };
    const spent = await this.agent.spentToday();
    if (spent >= BigInt(Math.round(this.env.DAILY_LLM_BUDGET_USD * 1_000_000))) {
      return { available: false, reason: 'the daily model budget is spent' };
    }
    return { available: true, reason: null };
  }

  /** The newest featured run of a preset; with `pendingToo`, one still being built counts. */
  private async featured(preset: DemoPreset, pendingToo: boolean): Promise<string | null> {
    const rows = await this.db
      .select({ id: reconRuns.id, config: reconRuns.config })
      .from(reconRuns)
      .where(
        and(
          sql`${reconRuns.config}->>'featured' = ${preset}`,
          sql`(${reconRuns.config}->>'featuredVersion')::int = ${FEATURED_VERSION}`,
        ),
      )
      .orderBy(desc(reconRuns.createdAt))
      .limit(5);
    for (const row of rows) {
      const stage = (row.config as { pipeline?: Pipeline }).pipeline?.stage;
      if (stage === 'ready' || (pendingToo && stage !== 'failed' && stage !== undefined))
        return row.id;
    }
    return null;
  }

  // --- starting a run -------------------------------------------------------------------------------------

  /**
   * Imports the dataset (a second or two) and returns the run's id; matching, the agent and verification
   * carry on in the background. `GET /runs/:id/progress` says how far they have got.
   */
  async start(options: StartOptions): Promise<string> {
    if (options.chaos === true) {
      // Faults are injected only where it is a demo, and only into the free scripted agent: the live
      // agent is paid for and its budget and circuit breaker are shared by every visitor.
      if (!this.env.DEMO_MODE)
        throw new BadRequestException('chaos is only available in DEMO_MODE');
      if (options.agent !== 'scripted')
        throw new BadRequestException('chaos injects failures into the scripted agent only');
    }
    if (options.agent === 'live') {
      const live = await this.liveStatus();
      if (!live.available)
        throw new ServiceUnavailableException(`live agent unavailable: ${live.reason}`);
    }
    const dir = await datasetDir(options.preset, DEMO_SEED);
    const { run } = await this.ingest.createDemo(dir);
    await this.patchConfig(run.id, {
      windows: windowsFor(options.preset, DEMO_SEED),
      demo: { preset: options.preset, seed: DEMO_SEED },
      ...(options.featured ? { featured: options.preset, featuredVersion: FEATURED_VERSION } : {}),
      pipeline: {
        stage: 'matching',
        agent: options.agent,
        preset: options.preset,
        startedAt: new Date().toISOString(),
      } satisfies Pipeline,
    });
    void this.pipeline(run.id, options.agent, options.chaos === true).catch((error: unknown) =>
      this.fail(run.id, error),
    );
    return run.id;
  }

  private async pipeline(runId: string, choice: AgentChoice, chaos: boolean): Promise<void> {
    await this.recon.match(runId);
    await this.patchPipeline(runId, { stage: 'investigating' });
    await this.db.update(reconRuns).set({ status: 'investigating' }).where(eq(reconRuns.id, runId));

    const scripted = choice === 'scripted';
    const agent = scripted ? await this.scriptedAgent(runId, chaos) : this.agent;
    const plan = await agent.plan(runId);
    await this.patchPipeline(runId, { expected: plan.exceptions });

    // A model that stops answering must not end the run: the agent pauses or the exception goes to a
    // person (resilient-runner.ts). What reaches here is a halt, or something unexpected in one job; a job
    // that fails leaves its exceptions open and the rest carry on.
    const halt: { reason: string | null } = { reason: null };
    const failed: { count: number; first: string | null } = { count: 0, first: null };
    const queue = [...plan.jobs];
    await Promise.all(
      Array.from(
        { length: Math.min(scripted ? JOBS_AT_ONCE : this.env.AGENT_CONCURRENCY, queue.length) },
        async () => {
          for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
            if (halt.reason !== null) return;
            try {
              await agent.process(job);
            } catch (error) {
              if (error instanceof AgentHalted) halt.reason = error.message;
              else {
                failed.count += 1;
                failed.first ??= error instanceof Error ? error.message : String(error);
                this.log.error(`investigation job failed in run ${runId}: ${String(error)}`);
              }
            }
          }
        },
      ),
    );

    const notes = [
      halt.reason === null ? null : `the agent stopped early: ${halt.reason}`,
      failed.count === 0
        ? null
        : `${failed.count} investigation job${failed.count === 1 ? '' : 's'} failed and left ${failed.count === 1 ? 'its' : 'their'} exceptions open (first error: ${(failed.first ?? '').slice(0, 200)})`,
    ].filter((n): n is string => n !== null);

    await this.db
      .update(reconRuns)
      .set({ status: 'complete', finishedAt: new Date() })
      .where(eq(reconRuns.id, runId));
    await this.patchPipeline(runId, {
      stage: 'ready',
      finishedAt: new Date().toISOString(),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    });
  }

  /** The free baseline agent; with `chaos`, two of its exceptions are made to fail on purpose. */
  private async scriptedAgent(runId: string, chaos: boolean): Promise<AgentService> {
    let runner: AgentRunner = new ScriptedRunner(await planPlants(this.db, runId));
    if (chaos) {
      const preview = await new AgentService(this.db, SCRIPTED_SETTINGS, null).plan(runId);
      const victims = planChaos(preview.jobs.flatMap((j) => j.items.map((i) => i.exceptionId)));
      await this.patchPipeline(runId, { chaos: victims });
      // The production wrapper, with a demo-sized wait, and a health of its own so one demo run cannot
      // pause another.
      runner = new ResilientRunner(new ChaosRunner(runner, victims), {
        health: new AgentHealth(),
        policy: CHAOS_RESILIENCE,
      });
    }
    return new AgentService(this.db, SCRIPTED_SETTINGS, runner, this.review);
  }

  private async fail(runId: string, error: unknown): Promise<void> {
    this.log.error(`demo run ${runId} failed: ${String(error)}`);
    try {
      await this.db.update(reconRuns).set({ status: 'failed' }).where(eq(reconRuns.id, runId));
      await this.patchPipeline(runId, {
        stage: 'failed',
        finishedAt: new Date().toISOString(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    } catch (inner) {
      this.log.error(`and could not record it: ${String(inner)}`);
    }
  }

  // --- progress ----------------------------------------------------------------------------------------------

  async progress(runId: string): Promise<Progress> {
    const [run] = await this.db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    if (run === undefined) throw new NotFoundException('no such run');
    const pipeline = (run.config as { pipeline?: Pipeline }).pipeline ?? {};

    const [groups, exceptions, proposals, waiting] = await Promise.all([
      this.db.select({ n: count() }).from(matchGroups).where(eq(matchGroups.runId, runId)),
      this.db.select({ n: count() }).from(reconExceptions).where(eq(reconExceptions.runId, runId)),
      this.db
        .select({ status: agentProposals.verifierStatus, n: count() })
        .from(agentProposals)
        .where(eq(agentProposals.runId, runId))
        .groupBy(agentProposals.verifierStatus),
      this.review.queue(runId, { limit: 1, offset: 0 }),
    ]);
    const by = (status: string) => proposals.find((p) => p.status === status)?.n ?? 0;
    return {
      runId,
      stage: pipeline.stage ?? 'unknown',
      agent: pipeline.agent ?? null,
      preset: pipeline.preset ?? null,
      startedAt: pipeline.startedAt ?? null,
      finishedAt: pipeline.finishedAt ?? null,
      error: pipeline.error ?? null,
      expected: pipeline.expected ?? null,
      note: pipeline.note ?? null,
      chaos: pipeline.chaos ?? null,
      counts: {
        groups: groups[0]?.n ?? 0,
        exceptions: exceptions[0]?.n ?? 0,
        proposals: proposals.reduce((sum, p) => sum + p.n, 0),
        verified: by('passed'),
        refused: by('rejected'),
        waiting: waiting.total,
      },
    };
  }

  // --- config helpers ---------------------------------------------------------------------------------------------

  private async patchConfig(runId: string, patch: Record<string, unknown>): Promise<void> {
    await this.db
      .update(reconRuns)
      .set({ config: sql`${reconRuns.config} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(reconRuns.id, runId));
  }

  private async patchPipeline(runId: string, patch: Pipeline): Promise<void> {
    await this.db
      .update(reconRuns)
      .set({
        config: sql`jsonb_set(${reconRuns.config}, '{pipeline}', coalesce(${reconRuns.config}->'pipeline', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(reconRuns.id, runId));
  }
}
