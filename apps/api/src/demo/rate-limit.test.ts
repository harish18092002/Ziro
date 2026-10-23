import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ENV as ENV_TOKEN } from '../config/config.module.js';
import { DemoController } from './demo.module.js';
import { DemoService } from './demo.service.js';
import { RateLimiter } from './rate-limit.js';

const MIN = 60_000;

describe('RateLimiter', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it('allows up to the limit and then says how long to wait', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 10 * MIN, max: 3 }], c.now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('a')).toEqual({ ok: true });
      c.advance(1_000);
    }
    // The first call was 3 s ago; it leaves the window 10 minutes after it was made.
    expect(limiter.check('a')).toEqual({ ok: false, retryAfterSeconds: 10 * 60 - 3 });
  });

  it('does not count a refused call, so waiting the stated time is enough', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: MIN, max: 1 }], c.now);
    expect(limiter.check('a').ok).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(limiter.check('a').ok).toBe(false);
    c.advance(MIN);
    expect(limiter.check('a').ok).toBe(true);
  });

  it('keeps callers apart', () => {
    const limiter = new RateLimiter([{ windowMs: MIN, max: 1 }]);
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('b').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(false);
  });

  it('applies every rule, and the longest wait wins', () => {
    const c = clock();
    const limiter = new RateLimiter(
      [
        { windowMs: MIN, max: 2 },
        { windowMs: 60 * MIN, max: 3 },
      ],
      c.now,
    );
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(true);
    const short = limiter.check('a');
    expect(short).toEqual({ ok: false, retryAfterSeconds: 60 });
    c.advance(MIN);
    expect(limiter.check('a').ok).toBe(true); // third in the hour
    c.advance(MIN);
    const long = limiter.check('a');
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.retryAfterSeconds).toBeGreaterThan(60);
  });

  it('never waits less than a second', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: 1_000, max: 1 }], c.now);
    limiter.check('a');
    c.advance(999);
    expect(limiter.check('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('peek says what check would, and counts nothing', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: MIN, max: 1 }], c.now);
    for (let i = 0; i < 5; i += 1) expect(limiter.peek('a')).toEqual({ ok: true });
    expect(limiter.check('a')).toEqual({ ok: true });
    expect(limiter.peek('a')).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.check('a').ok).toBe(false);
  });

  it('stays bounded however many different callers arrive', () => {
    const c = clock();
    const limiter = new RateLimiter([{ windowMs: MIN, max: 1 }], c.now, 50);
    for (let i = 0; i < 500; i += 1) limiter.check(`client-${i}`);
    // Internal size is capped; an old caller that fell out is simply treated as new.
    expect(limiter.check('client-0').ok).toBe(true);
    c.advance(2 * MIN);
    expect(limiter.check('client-1').ok).toBe(true);
  });
});

describe('POST /demo/runs and /demo/reset under the limits', () => {
  const ENV = {
    DEMO_LIVE_RUNS_PER_IP_HOUR: 2,
    DEMO_LIVE_RUNS_PER_HOUR: 3,
    DEMO_RUNS_PER_IP_HOUR: 4,
    DEMO_RUNS_PER_HOUR: 6,
  };
  const apps: INestApplication[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
  });

  async function boot(env = ENV) {
    const calls = { start: [] as unknown[], reset: [] as string[] };
    const stub = {
      start: (o: unknown) => {
        calls.start.push(o);
        return Promise.resolve(`run-${calls.start.length}`);
      },
      reset: (id: string) => {
        calls.reset.push(id);
        return Promise.resolve({ archived: id, runId: 'fresh' });
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        { provide: DemoService, useValue: stub },
        { provide: ENV_TOKEN, useValue: env },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    apps.push(app);
    return { server: app.getHttpServer() as Parameters<typeof request>[0], calls };
  }
  const live = { agent: 'live' };

  it('limits live runs per visitor first, saying so, and the refused call does no work', async () => {
    const { server, calls } = await boot();
    for (let i = 0; i < 2; i += 1)
      expect((await request(server).post('/demo/runs').send(live)).status).toBe(202);
    const third = await request(server).post('/demo/runs').send(live);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'too_many_runs' });
    expect((third.body as { message: string }).message).toContain(
      'live runs are limited per visitor',
    );
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls.start).toHaveLength(2);
  });

  it('leaves the free scripted run available to a visitor who used up their live runs', async () => {
    const { server } = await boot();
    for (let i = 0; i < 2; i += 1) await request(server).post('/demo/runs').send(live);
    expect((await request(server).post('/demo/runs').send(live)).status).toBe(429);
    expect((await request(server).post('/demo/runs').send({})).status).toBe(202);
  });

  it('counts a live run against the general limit too, and the scripted ones against it', async () => {
    const { server } = await boot();
    for (let i = 0; i < 2; i += 1) await request(server).post('/demo/runs').send(live); // 2 of 4
    for (let i = 0; i < 2; i += 1)
      expect((await request(server).post('/demo/runs').send({})).status).toBe(202); // 4 of 4
    const fifth = await request(server).post('/demo/runs').send({});
    expect(fifth.status).toBe(429);
    expect((fifth.body as { message: string }).message).toContain('runs are limited per visitor');
  });

  it('a call refused by one limit does not spend the allowance of the others', async () => {
    const { server } = await boot({ ...ENV, DEMO_LIVE_RUNS_PER_IP_HOUR: 0 });
    // Every live call is refused by the per-visitor live limit, however many times it is tried...
    for (let i = 0; i < 10; i += 1)
      expect((await request(server).post('/demo/runs').send(live)).status).toBe(429);
    // ...and none of those used up the general allowance of 4.
    for (let i = 0; i < 4; i += 1)
      expect((await request(server).post('/demo/runs').send({})).status).toBe(202);
  });

  it('a reset counts as a run, and is refused with the same 429 once the limit is reached', async () => {
    const { server, calls } = await boot({ ...ENV, DEMO_RUNS_PER_IP_HOUR: 1 });
    const id = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
    const first = await request(server).post('/demo/reset').send({ runId: id });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ archived: id, runId: 'fresh' });
    expect((await request(server).post('/demo/reset').send({ runId: id })).status).toBe(429);
    expect(calls.reset).toEqual([id]);
  });

  it('refuses a reset that does not name a run, or names more than that', async () => {
    const { server } = await boot();
    expect((await request(server).post('/demo/reset').send({})).status).toBe(400);
    expect((await request(server).post('/demo/reset').send({ runId: 'x' })).status).toBe(400);
    expect(
      (
        await request(server)
          .post('/demo/reset')
          .send({ runId: '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', all: true })
      ).status,
    ).toBe(400);
  });
});
