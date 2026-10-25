import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DB, DbModule } from '../db/db.module.js';
import { PgCacheStore } from '../llm/cache.pg.js';
import { type BuiltRouter, buildRouter } from '../llm/factory.js';
import { RedisLimiter } from '../llm/limiter.js';
import { ReviewModule } from '../review/review.module.js';
import { AGENT_RUNNER, AgentService, LLM_ROUTER } from './agent.service.js';
import { AgentController, AgentStatusController } from './agent.controller.js';
import { DEFAULT_LIMITS } from './budget.js';
import { LoopRunner } from './loop-runner.js';
import { SingleShotRunner } from './single-shot.js';
import {
  BullInvestigationQueue,
  INVESTIGATION_QUEUE,
  type InvestigationQueue,
  startInvestigationWorker,
} from './queue.js';
import type { AgentRunner } from './types.js';
import type { Executor } from '../db/executor.js';

const LLM_REDIS = Symbol('LLM_REDIS');

/**
 * The harness named by AGENT_HARNESS on the models LLM_CHAIN names, or none when no model in the chain can
 * be used (the rules, the review console and the replay work without one). A chain entry that cannot be
 * used is dropped with a warning in `built`, never a boot failure.
 */
export function createRunner(env: Env, built: BuiltRouter): AgentRunner | null {
  if (built.router === null) return null;
  const options = {
    router: built.router,
    escalation: env.AGENT_ESCALATION,
    limits: { ...DEFAULT_LIMITS, maxToolCalls: env.LLM_MAX_TOOL_CALLS },
  };
  return env.AGENT_HARNESS === 'loop' ? new LoopRunner(options) : new SingleShotRunner(options);
}

/** Starts the worker in this process when AGENT_WORKER_ENABLED, and stops it with the app. */
@Injectable()
export class AgentWorkerHost implements OnModuleInit, OnApplicationShutdown {
  private worker: Worker | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly agent: AgentService,
    @Inject(INVESTIGATION_QUEUE) private readonly queue: InvestigationQueue,
    @Inject(LLM_REDIS) private readonly limiterRedis: Redis,
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
    this.limiterRedis.disconnect();
  }
}

@Module({
  imports: [DbModule, ReviewModule],
  controllers: [AgentController, AgentStatusController],
  providers: [
    {
      // The limiter's own connection, opened on first use: a boot with no model configured never connects.
      provide: LLM_REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 3_000,
        }),
    },
    {
      provide: LLM_ROUTER,
      inject: [ENV, DB, LLM_REDIS],
      useFactory: (env: Env, db: Executor, redis: Redis): BuiltRouter => {
        const log = new Logger('Llm');
        const built = buildRouter(env, {
          limiter: new RedisLimiter(redis),
          ...(env.LLM_CACHE === 'off' ? {} : { cacheStore: new PgCacheStore(db) }),
          warn: (message) => log.warn(message),
        });
        for (const warning of built.warnings) log.warn(warning);
        if (built.router !== null) {
          log.log(
            `model chain: ${built.router.chain.map((e) => e.id).join(' > ')} (cache ${env.LLM_CACHE}, ${env.GEMINI_TIER} tier)`,
          );
        }
        return built;
      },
    },
    {
      provide: AGENT_RUNNER,
      inject: [ENV, LLM_ROUTER],
      useFactory: (env: Env, built: BuiltRouter) => createRunner(env, built),
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
