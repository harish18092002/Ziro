// BullMQ glue: one queue of investigation jobs and the worker that drains it. The queue is a port
// (`InvestigationQueue`) so the controller and the service never import BullMQ and tests can swap in a
// recorder. Redis holds only job envelopes (run and exception ids, attempt numbers): no record data.
import { Logger } from '@nestjs/common';
import { type ConnectionOptions, type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { LlmError } from './llm.js';
import { type InvestigationJob, investigationJobSchema, jobKey } from './jobs.js';
import { PricingError } from './pricing.js';
import { AgentHalted } from './types.js';

export const INVESTIGATION_QUEUE = Symbol('INVESTIGATION_QUEUE');
// BullMQ queue names may not contain ":".
export const QUEUE_NAME = 'ziro-investigations';

export interface InvestigationQueue {
  enqueue(jobs: readonly InvestigationJob[]): Promise<void>;
  close?(): Promise<void>;
}

/**
 * BullMQ's connection from a redis:// or rediss:// URL. `maxRetriesPerRequest: null` is required for a
 * worker, whose blocking commands must wait out a Redis restart rather than fail after a few retries.
 */
export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const database = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
    ...(Number.isInteger(database) && database > 0 ? { db: database } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

/*
 * Jobs are removed when they finish or fail (removeOnComplete / removeOnFail below). A kept job would
 * block the same id being added again, and re-adding is exactly what a person does after a halt or a
 * failure; the database's unique (exception, attempt) index prevents double work, not the queue. The
 * queue only de-duplicates jobs that are still waiting or running.
 */
const ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5_000;

export class BullInvestigationQueue implements InvestigationQueue {
  private readonly queue: Queue;

  constructor(
    redisUrl: string,
    name: string = QUEUE_NAME,
    private readonly backoffMs: number = DEFAULT_BACKOFF_MS,
  ) {
    this.queue = new Queue(name, { connection: redisConnection(redisUrl) });
    const logger = new Logger('InvestigationQueue');
    this.queue.on('error', (error) => logger.warn(`queue error: ${error.message}`));
  }

  async enqueue(jobs: readonly InvestigationJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(
      jobs.map((job) => ({
        name: 'investigate',
        data: job,
        opts: {
          jobId: jobKey(job),
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: this.backoffMs },
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Failures a retry cannot cure: the job stops, and the exceptions stay open for a person to re-run. */
function isFinal(error: unknown): boolean {
  return (
    error instanceof AgentHalted ||
    error instanceof PricingError ||
    (error instanceof LlmError && !error.retryable)
  );
}

export interface WorkerOptions {
  readonly redisUrl: string;
  readonly concurrency: number;
  readonly name?: string;
  readonly process: (job: InvestigationJob) => Promise<unknown>;
}

export function startInvestigationWorker(options: WorkerOptions): Worker {
  const logger = new Logger('InvestigationWorker');
  const worker = new Worker(
    options.name ?? QUEUE_NAME,
    async (job: Job) => {
      const data = investigationJobSchema.safeParse(job.data);
      if (!data.success) throw new UnrecoverableError('the job does not describe an investigation');
      try {
        return await options.process(data.data);
      } catch (error) {
        if (error instanceof AgentHalted) {
          // Not a failure of the job: nothing was spent past the limit and nothing changed. It
          // finishes, the exceptions stay open, and asking again later enqueues it afresh.
          logger.warn(`halted: ${error.message}`);
          return { halted: error.reason };
        }
        if (isFinal(error))
          throw new UnrecoverableError(error instanceof Error ? error.message : 'failed');
        throw error;
      }
    },
    { connection: redisConnection(options.redisUrl), concurrency: options.concurrency },
  );
  worker.on('failed', (job, error) =>
    logger.error(`job ${job?.id ?? '?'} failed: ${error.message}`),
  );
  worker.on('error', (error) => logger.warn(`worker error: ${error.message}`));
  return worker;
}
