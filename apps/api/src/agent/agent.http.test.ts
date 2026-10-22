// POST /runs/:id/investigate end to end: the real controller and service, a PGlite database built from
// the migrations, and a queue that only records what it is given.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../config/config.module.js';
import { DB } from '../db/db.module.js';
import { reconExceptions } from '../db/schema.js';
import { AgentController } from './agent.controller.js';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { AGENT_RUNNER, AgentService } from './agent.service.js';
import { createRunner, loopRunnerOptions } from './agent.module.js';
import type { InvestigationJob } from './jobs.js';
import { INVESTIGATION_QUEUE } from './queue.js';
import type { AgentRunner } from './types.js';
import { loadEnv } from '../config/env.js';

let db: TestDb;
let dbClient: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;

beforeAll(async () => {
  ({ db, client: dbClient } = await createMigratedDb());
  world = await buildWorld(db);
}, 60_000);
afterAll(async () => {
  await dbClient.close();
});

const RUNNER = { harness: 'loop', investigate: () => Promise.resolve([]) } satisfies AgentRunner;

async function app(runner: AgentRunner | null, settings: Record<string, unknown> = {}) {
  const queued: InvestigationJob[] = [];
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentController],
    providers: [
      { provide: DB, useValue: db },
      {
        provide: ENV,
        useValue: {
          AGENT_KILL_SWITCH: false,
          DAILY_LLM_BUDGET_USD: 5,
          CLUSTER_EXCEPTIONS: false,
          ...settings,
        },
      },
      { provide: AGENT_RUNNER, useValue: runner },
      {
        provide: INVESTIGATION_QUEUE,
        useValue: {
          enqueue: (jobs: readonly InvestigationJob[]) => {
            queued.push(...jobs);
            return Promise.resolve();
          },
        },
      },
      AgentService,
    ],
  }).compile();
  const nest: INestApplication = moduleRef.createNestApplication();
  await nest.init();
  return { nest, queued, server: nest.getHttpServer() as Parameters<typeof request>[0] };
}

describe('POST /runs/:id/investigate', () => {
  it('queues every open exception and answers 202 with counts', async () => {
    const { nest, queued, server } = await app(RUNNER);
    const res = await request(server).post(`/runs/${world.runId}/investigate`).send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      runId: world.runId,
      exceptions: 2,
      jobs: 2,
      skipped: {
        count: 1,
        examples: [
          {
            exceptionId: world.exceptions.unexplainedCredit,
            why: expect.stringContaining('listed for a person') as string,
          },
        ],
      },
    });
    expect(queued.map((j) => j.items[0]?.exceptionId).sort()).toEqual(
      [world.exceptions.duplicate, world.exceptions.other].sort(),
    );
    expect(queued.every((j) => j.runId === world.runId && j.items.length === 1)).toBe(true);
    await nest.close();
  });

  it('accepts a request with no body at all', async () => {
    const { nest, queued, server } = await app(RUNNER);
    const res = await request(server).post(`/runs/${world.runId}/investigate`);
    expect(res.status).toBe(202);
    expect(queued).toHaveLength(2);
    await nest.close();
  });

  it('queues just one exception when asked for one', async () => {
    const { nest, queued, server } = await app(RUNNER);
    const res = await request(server)
      .post(`/runs/${world.runId}/investigate`)
      .send({ exceptionId: world.exceptions.other });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ exceptions: 1, jobs: 1 });
    expect(queued).toHaveLength(1);
    await nest.close();
  });

  it('clusters when CLUSTER_EXCEPTIONS is on', async () => {
    const { nest, server } = await app(RUNNER, { CLUSTER_EXCEPTIONS: true });
    const res = await request(server).post(`/runs/${world.runId}/investigate`).send({});
    expect(res.status).toBe(202);
    const body = res.body as { exceptions: number; jobs: number };
    expect(body.exceptions).toBe(2);
    expect(body.jobs).toBeLessThanOrEqual(2);
    await nest.close();
  });

  it('answers 404 for an unknown run or exception, 400 for malformed input, 409 for one not open', async () => {
    const { nest, queued, server } = await app(RUNNER);
    expect((await request(server).post(`/runs/${randomUUID()}/investigate`).send({})).status).toBe(
      404,
    );
    expect((await request(server).post(`/runs/not-a-uuid/investigate`).send({})).status).toBe(400);
    expect(
      (await request(server).post(`/runs/${world.runId}/investigate`).send({ exceptionId: 'nope' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`/runs/${world.runId}/investigate`)
          .send({ exceptionId: world.exceptions.other, approve: true })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`/runs/${world.runId}/investigate`)
          .send({ exceptionId: randomUUID() })
      ).status,
    ).toBe(404);

    await db
      .update(reconExceptions)
      .set({ status: 'proposed' })
      .where(eq(reconExceptions.id, world.exceptions.other));
    expect(
      (
        await request(server)
          .post(`/runs/${world.runId}/investigate`)
          .send({ exceptionId: world.exceptions.other })
      ).status,
    ).toBe(409);
    expect(queued).toHaveLength(0);
    await db
      .update(reconExceptions)
      .set({ status: 'open' })
      .where(eq(reconExceptions.id, world.exceptions.other));
    await nest.close();
  });

  it('does not queue what already has a proposal: asking twice does not spend twice', async () => {
    const { nest, queued, server } = await app(RUNNER);
    await db
      .update(reconExceptions)
      .set({ status: 'proposed' })
      .where(eq(reconExceptions.id, world.exceptions.duplicate));
    const res = await request(server).post(`/runs/${world.runId}/investigate`).send({});
    expect(res.body).toMatchObject({ exceptions: 1, jobs: 1 });
    expect(queued.flatMap((j) => j.items.map((i) => i.exceptionId))).toEqual([
      world.exceptions.other,
    ]);
    await db
      .update(reconExceptions)
      .set({ status: 'open' })
      .where(eq(reconExceptions.id, world.exceptions.duplicate));
    await nest.close();
  });

  it('answers 503, and queues nothing, when no API key is configured', async () => {
    const { nest, queued, server } = await app(null);
    const res = await request(server).post(`/runs/${world.runId}/investigate`).send({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('ANTHROPIC_API_KEY');
    expect(queued).toHaveLength(0);
    await nest.close();
  });
});

describe('createRunner', () => {
  const env = (over: Record<string, string | undefined>) =>
    loadEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      SYNTHETIC_DATA_DIR: 'data/demo',
      RAZORPAY_SOURCE: 'synthetic',
      AGENT_MODEL_SMALL: 'claude-haiku-5-5',
      AGENT_MODEL_LARGE: 'claude-sonnet-5-5',
      AGENT_HARNESS: 'loop',
      AUTO_ACCEPT_ENABLED: 'false',
      AUTO_ACCEPT_MAX_PAISE: '0',
      DEMO_MODE: 'true',
      DAILY_LLM_BUDGET_USD: '5',
      AGENT_KILL_SWITCH: 'false',
      ...over,
    });

  it('builds no harness without an API key', () => {
    expect(createRunner(env({}))).toBeNull();
    expect(createRunner(env({ ANTHROPIC_API_KEY: '' }))).toBeNull();
  });

  it('builds the loop harness with a key and priced models', () => {
    const runner = createRunner(env({ ANTHROPIC_API_KEY: 'sk-test' }));
    expect(runner?.harness).toBe('loop');
  });

  it('refuses at boot a model it cannot price, naming the variable and never the key', () => {
    expect(() =>
      createRunner(
        env({ ANTHROPIC_API_KEY: 'sk-secret-123', AGENT_MODEL_LARGE: 'claude-mystery-9' }),
      ),
    ).toThrow(/AGENT_MODEL_LARGE "claude-mystery-9"/);
    try {
      createRunner(env({ ANTHROPIC_API_KEY: 'sk-secret-123', AGENT_MODEL_SMALL: 'nope' }));
    } catch (error) {
      expect(String(error)).not.toContain('sk-secret-123');
    }
  });

  it('passes the models and the escalation setting from the environment to the loop harness', () => {
    const client = { complete: () => Promise.reject(new Error('unused')) };
    const on = loopRunnerOptions(env({ AGENT_ESCALATION: 'true' }), client);
    expect(on).toEqual({
      client,
      smallModel: 'claude-haiku-5-5',
      largeModel: 'claude-sonnet-5-5',
      escalation: true,
    });
    expect(loopRunnerOptions(env({ AGENT_ESCALATION: 'false' }), client).escalation).toBe(false);
    expect(
      loopRunnerOptions(
        env({ AGENT_MODEL_SMALL: 'claude-sonnet-5-5', AGENT_MODEL_LARGE: 'claude-haiku-5-5' }),
        client,
      ),
    ).toMatchObject({ smallModel: 'claude-sonnet-5-5', largeModel: 'claude-haiku-5-5' });
  });

  it('refuses the agent-sdk harness until it exists', () => {
    expect(() =>
      createRunner(env({ ANTHROPIC_API_KEY: 'sk-test', AGENT_HARNESS: 'agent-sdk' })),
    ).toThrow(/P11/);
  });
});
