// The BullMQ glue against a real Redis, but only the LOCAL one from docker-compose (127.0.0.1:6379).
// Each run uses a queue name of its own and removes it afterwards. Skipped when nothing answers.
import { randomUUID } from 'node:crypto';
import { Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InvestigationJob } from './jobs.js';
import { LlmError } from './llm.js';
import { PricingError } from './pricing.js';
import { LOCAL_REDIS_URL, localRedisAnswers, until } from './redis.fixtures.js';
import { BullInvestigationQueue, redisConnection, startInvestigationWorker } from './queue.js';
import { AgentHalted } from './types.js';

const URL = LOCAL_REDIS_URL;

const available = await localRedisAnswers();

const makeJob = (n = 1): InvestigationJob => ({
  runId: randomUUID(),
  clusterId: null,
  items: [{ exceptionId: randomUUID(), attempt: n }],
});

describe('redisConnection', () => {
  it('reads host, port, credentials, database and TLS from the URL', () => {
    expect(redisConnection('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
    expect(redisConnection('redis://u:p%40ss@h:6380/3')).toEqual({
      host: 'h',
      port: 6380,
      username: 'u',
      password: 'p@ss',
      db: 3,
      maxRetriesPerRequest: null,
    });
    expect(redisConnection('rediss://:secret@cloud.example:6379')).toMatchObject({
      tls: {},
      password: 'secret',
    });
    expect(redisConnection('redis://h')).toMatchObject({ port: 6379 });
  });
});

describe.skipIf(!available)('investigation queue on local Redis', () => {
  const name = `ziro-test-${randomUUID().slice(0, 8)}`;
  let inspect: Queue;
  let queue: BullInvestigationQueue;
  let worker: Worker | null = null;

  beforeAll(() => {
    inspect = new Queue(name, { connection: redisConnection(URL) });
    queue = new BullInvestigationQueue(URL, name, 10);
  });
  afterEach(async () => {
    await worker?.close();
    worker = null;
    await inspect.obliterate({ force: true });
  });
  afterAll(async () => {
    await queue.close();
    await inspect.obliterate({ force: true }).catch(() => undefined);
    await inspect.close();
  });

  const start = (process: (job: InvestigationJob) => Promise<unknown>, concurrency = 2) => {
    worker = startInvestigationWorker({ redisUrl: URL, name, concurrency, process });
    return worker.waitUntilReady();
  };

  it('keeps one job when the same one is enqueued twice', async () => {
    const job = makeJob();
    await queue.enqueue([job]);
    await queue.enqueue([job, job]);
    expect(await inspect.getJobCounts('waiting', 'delayed', 'active')).toMatchObject({
      waiting: 1,
    });
  });

  it('runs a job with its data once, then forgets it so it can be enqueued again', async () => {
    const seen: InvestigationJob[] = [];
    const job = makeJob();
    await start((j) => {
      seen.push(j);
      return Promise.resolve();
    });
    await queue.enqueue([job]);
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(job);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await inspect.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ).toEqual({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
    await queue.enqueue([job]);
    await until(() => seen.length === 2);
  });

  it('does not run anything for a job that is not an investigation', async () => {
    let ran = 0;
    await start(() => {
      ran += 1;
      return Promise.resolve();
    });
    await inspect.add(
      'investigate',
      { nonsense: true },
      { attempts: 3, backoff: { type: 'fixed', delay: 10 }, removeOnFail: true },
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(ran).toBe(0);
    expect((await inspect.getJobCounts('waiting', 'active', 'delayed')).delayed).toBe(0); // not retried either
  });

  it('finishes a halted job without a retry, leaving the exceptions for a later request', async () => {
    let ran = 0;
    await start(() => {
      ran += 1;
      return Promise.reject(new AgentHalted('daily_budget'));
    });
    await queue.enqueue([makeJob()]);
    await until(() => ran === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toBe(1);
  });

  it.each([
    ['an API error that retrying cannot fix', () => new LlmError('bad request', false, 400, null)],
    ['a model with no price', () => new PricingError('no price')],
  ])('does not retry %s', async (_label, make) => {
    let ran = 0;
    await start(() => {
      ran += 1;
      return Promise.reject(make());
    });
    await queue.enqueue([makeJob()]);
    await until(() => ran === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toBe(1);
  });

  it('retries a transient failure, up to three attempts', async () => {
    let ran = 0;
    await start(() => {
      ran += 1;
      return Promise.reject(new LlmError('overloaded', true, 529, null));
    });
    await queue.enqueue([makeJob()]);
    await until(() => ran === 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toBe(3);
  });

  it('succeeds on a retry', async () => {
    let ran = 0;
    await start(() => {
      ran += 1;
      return ran === 1
        ? Promise.reject(new LlmError('overloaded', true, 529, null))
        : Promise.resolve();
    });
    await queue.enqueue([makeJob()]);
    await until(() => ran === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(ran).toBe(2);
  });

  it('never runs more jobs at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    let done = 0;
    await start(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 60));
      active -= 1;
      done += 1;
    }, 2);
    await queue.enqueue([makeJob(), makeJob(), makeJob(), makeJob(), makeJob(), makeJob()]);
    await until(() => done === 6);
    expect(peak).toBe(2);
  });
});
