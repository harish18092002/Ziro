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
import { createRunner } from './agent.module.js';
import { buildRouter } from '../llm/factory.js';
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

const RUNNER = {
  harness: 'single-shot',
  investigate: () => Promise.resolve([]),
} satisfies AgentRunner;

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

  it('answers 503, and queues nothing, when no model is usable', async () => {
    const { nest, queued, server } = await app(null);
    const res = await request(server).post(`/runs/${world.runId}/investigate`).send({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('GEMINI_API_KEY');
    expect(queued).toHaveLength(0);
    await nest.close();
  });
});

describe('createRunner and buildRouter', () => {
  const env = (over: Record<string, string | undefined>) =>
    loadEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      SYNTHETIC_DATA_DIR: 'data/demo',
      RAZORPAY_SOURCE: 'synthetic',
      AUTO_ACCEPT_ENABLED: 'false',
      AUTO_ACCEPT_MAX_PAISE: '0',
      DEMO_MODE: 'true',
      DAILY_LLM_BUDGET_USD: '5',
      AGENT_KILL_SWITCH: 'false',
      ...over,
    });
  const build = (over: Record<string, string | undefined>) => {
    const e = env(over);
    return { e, built: buildRouter(e) };
  };

  it('builds no harness, and says why, when there is no chain', () => {
    const { e, built } = build({});
    expect(createRunner(e, built)).toBeNull();
    expect(built.warnings.join(' ')).toContain('LLM_CHAIN is empty');
  });

  it('builds no harness, and does not fail the boot, when the chain has no usable key', () => {
    const { e, built } = build({ LLM_CHAIN: 'gemini:a,anthropic:b' });
    expect(createRunner(e, built)).toBeNull();
    expect(built.dropped.map((d) => d.id)).toEqual(['gemini:a', 'anthropic:b']);
    expect(built.dropped[0]?.why).toContain('GEMINI_API_KEY');
    expect(built.dropped[1]?.why).toContain('ANTHROPIC_API_KEY');
  });

  it('builds the single-shot harness by default, from a Gemini key alone', () => {
    const { e, built } = build({ LLM_CHAIN: 'gemini:a', GEMINI_API_KEY: 'g-test' });
    expect(createRunner(e, built)?.harness).toBe('single-shot');
    expect(built.router?.chain.map((c) => c.id)).toEqual(['gemini:a']);
  });

  it('builds the loop harness when AGENT_HARNESS says so', () => {
    const { e, built } = build({
      LLM_CHAIN: 'gemini:a',
      GEMINI_API_KEY: 'g-test',
      AGENT_HARNESS: 'loop',
    });
    expect(createRunner(e, built)?.harness).toBe('loop');
  });

  it('drops Claude with a warning when it has no key, and keeps Gemini: Anthropic is optional', () => {
    const { built } = build({ LLM_CHAIN: 'gemini:a,anthropic:b', GEMINI_API_KEY: 'g-test' });
    expect(built.router?.chain.map((c) => c.id)).toEqual(['gemini:a']);
    expect(built.dropped).toEqual([
      { id: 'anthropic:b', why: expect.stringContaining('ANTHROPIC_API_KEY') as string },
    ]);
  });

  it('keeps Claude only with a key AND a price, because its spend must be counted', () => {
    const noPrice = build({
      LLM_CHAIN: 'gemini:a,anthropic:b',
      GEMINI_API_KEY: 'g-test',
      ANTHROPIC_API_KEY: 'sk-test',
    });
    expect(noPrice.built.router?.chain.map((c) => c.id)).toEqual(['gemini:a']);
    expect(noPrice.built.dropped[0]?.why).toContain('LLM_PRICES');

    const priced = build({
      LLM_CHAIN: 'gemini:a,anthropic:b',
      GEMINI_API_KEY: 'g-test',
      ANTHROPIC_API_KEY: 'sk-test',
      LLM_PRICES: '{"anthropic:b":{"input":"1","output":"5"}}',
    });
    expect(priced.built.router?.chain.map((c) => c.id)).toEqual(['gemini:a', 'anthropic:b']);
  });

  it('wants a price for Gemini too on the paid tier, but not on the free one', () => {
    const free = build({ LLM_CHAIN: 'gemini:a', GEMINI_API_KEY: 'g-test' });
    expect(free.built.router).not.toBeNull();
    const paid = build({ LLM_CHAIN: 'gemini:a', GEMINI_API_KEY: 'g-test', GEMINI_TIER: 'paid' });
    expect(paid.built.router).toBeNull();
    expect(paid.built.dropped[0]?.why).toContain('LLM_PRICES');
  });

  it('warns, at boot, about a free-tier Gemini model with no limits, and never guesses any', () => {
    const { built } = build({ LLM_CHAIN: 'gemini:a', GEMINI_API_KEY: 'g-test' });
    expect(built.warnings.join(' ')).toContain('no request limits for gemini:a');
    const withLimits = build({
      LLM_CHAIN: 'gemini:a',
      GEMINI_API_KEY: 'g-test',
      GEMINI_LIMITS: '{"a":{"rpm":5,"rpd":20}}',
    });
    expect(withLimits.built.warnings).toEqual([]);
  });

  it('needs no key at all to replay: nothing is ever sent', () => {
    const { e, built } = build({ LLM_CHAIN: 'gemini:a,anthropic:b', LLM_CACHE: 'replay' });
    expect(createRunner(e, built)).not.toBeNull();
    expect(built.dropped).toEqual([]);
  });

  it('never puts a key in a warning or a dropped reason', () => {
    const { built } = build({
      LLM_CHAIN: 'gemini:a,anthropic:b',
      ANTHROPIC_API_KEY: 'sk-secret-123',
    });
    expect(JSON.stringify(built)).not.toContain('sk-secret-123');
  });

  it('passes the escalation setting and the tool-call limit from the environment', () => {
    const base = { LLM_CHAIN: 'gemini:a,gemini:b', GEMINI_API_KEY: 'g-test' };
    const on = build({ ...base, AGENT_ESCALATION: 'true', LLM_MAX_TOOL_CALLS: '6' });
    expect(on.e.AGENT_ESCALATION).toBe(true);
    expect(on.e.LLM_MAX_TOOL_CALLS).toBe(6);
    expect(env(base).AGENT_ESCALATION).toBe(false); // off unless asked for
    expect(env(base).LLM_MAX_TOOL_CALLS).toBe(4);
  });
});
