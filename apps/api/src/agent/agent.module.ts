import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Worker } from 'bullmq';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DbModule } from '../db/db.module.js';
import { ReviewModule } from '../review/review.module.js';
import { AnthropicLlmClient } from './anthropic-client.js';
import { AGENT_HEALTH, AGENT_RUNNER, AgentService } from './agent.service.js';
import { AgentController, AgentStatusController } from './agent.controller.js';
import type { LlmClient } from './llm.js';
import { LoopRunner, type LoopRunnerOptions } from './loop-runner.js';
import { AgentHealth } from './health.js';
import { ratesFor } from './pricing.js';
import { ResilientRunner } from './resilient-runner.js';
import { SdkRunner } from './sdk-runner.js';
import {
  BullInvestigationQueue,
  INVESTIGATION_QUEUE,
  type InvestigationQueue,
  startInvestigationWorker,
} from './queue.js';
import type { AgentRunner } from './types.js';

/**
 * The harness named by AGENT_HARNESS, or none when there is no API key (the free replay and the rest
 * of the app work without one). A harness that cannot work is a boot failure, not a silent no-op.
 */
export function createRunner(
  env: Env,
  health: AgentHealth = new AgentHealth(),
): AgentRunner | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const base = createHarness(env, env.ANTHROPIC_API_KEY);
  // Whatever the harness, a model API that misbehaves degrades an investigation to a person, or pauses
  // the agent; it never fails the job or the run (resilient-runner.ts).
  return new ResilientRunner(base, { health });
}

function createHarness(env: Env, apiKey: string): AgentRunner {
  // Harness B runs one model and does not escalate; it needs only the small model's price.
  const models =
    env.AGENT_HARNESS === 'agent-sdk'
      ? ([['AGENT_MODEL_SMALL', env.AGENT_MODEL_SMALL]] as const)
      : ([
          ['AGENT_MODEL_SMALL', env.AGENT_MODEL_SMALL],
          ['AGENT_MODEL_LARGE', env.AGENT_MODEL_LARGE],
        ] as const);
  for (const [name, model] of models) {
    if (ratesFor(model) === undefined) {
      throw new Error(
        `${name} "${model}" has no known price; add it to agent/pricing.ts before using it`,
      );
    }
  }
  if (env.AGENT_HARNESS === 'agent-sdk') {
    return new SdkRunner({ apiKey, model: env.AGENT_MODEL_SMALL });
  }
  return new LoopRunner(loopRunnerOptions(env, AnthropicLlmClient.fromApiKey(apiKey)));
}

/** What the environment decides about the loop harness: its models and whether it may escalate. */
export function loopRunnerOptions(env: Env, client: LlmClient): LoopRunnerOptions {
  return {
    client,
    smallModel: env.AGENT_MODEL_SMALL,
    largeModel: env.AGENT_MODEL_LARGE,
    escalation: env.AGENT_ESCALATION,
  };
}

/** Starts the worker in this process when AGENT_WORKER_ENABLED, and stops it with the app. */
@Injectable()
export class AgentWorkerHost implements OnModuleInit, OnApplicationShutdown {
  private worker: Worker | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly agent: AgentService,
    @Inject(INVESTIGATION_QUEUE) private readonly queue: InvestigationQueue,
  ) {}

  onModuleInit(): void {
    if (!this.env.AGENT_WORKER_ENABLED || !this.agent.configured) return;
    this.worker = startInvestigationWorker({
      redisUrl: this.env.REDIS_URL,
      concurrency: this.env.AGENT_CONCURRENCY,
      process: (job) => this.agent.process(job),
    });
    new Logger('AgentWorker').log(
      `investigation worker started (concurrency ${this.env.AGENT_CONCURRENCY})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close?.();
  }
}

@Module({
  imports: [DbModule, ReviewModule],
  controllers: [AgentController, AgentStatusController],
  providers: [
    { provide: AGENT_HEALTH, useFactory: (): AgentHealth => new AgentHealth() },
    {
      provide: AGENT_RUNNER,
      inject: [ENV, AGENT_HEALTH],
      useFactory: (env: Env, health: AgentHealth) => createRunner(env, health),
    },
    {
      provide: INVESTIGATION_QUEUE,
      inject: [ENV],
      useFactory: (env: Env): InvestigationQueue => new BullInvestigationQueue(env.REDIS_URL),
    },
    AgentService,
    AgentWorkerHost,
  ],
  exports: [AgentService],
})
export class AgentModule {}
