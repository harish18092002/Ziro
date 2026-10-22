import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('POST /demo/runs under the limiter', () => {
  let app: INestApplication;
  let started = 0;

  beforeAll(async () => {
    const stub = { start: () => Promise.resolve(`run-${++started}`) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [{ provide: DemoService, useValue: stub }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('lets a client start five runs in ten minutes, and tells the sixth when to come back', async () => {
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    for (let i = 0; i < 5; i += 1) {
      expect((await request(server).post('/demo/runs').send({})).status).toBe(202);
    }
    const sixth = await request(server).post('/demo/runs').send({});
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: 'too_many_runs' });
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(started).toBe(5); // the refused call did no work
  });
});
