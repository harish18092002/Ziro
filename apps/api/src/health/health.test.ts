import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { DB_PROBE, type Probe, REDIS_PROBE, withTimeout } from './probe.js';

const up: Probe = () => Promise.resolve();
const down: Probe = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432'));

describe('GET /health', () => {
  let app: INestApplication | undefined;

  // Also proves constructor injection works under Vitest (emitDecoratorMetadata).
  async function getHealth(db: Probe, redis: Probe) {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DB_PROBE, useValue: db },
        { provide: REDIS_PROBE, useValue: redis },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // getHttpServer() is typed `any` by Nest.
    return request(app.getHttpServer() as Server).get('/health');
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 200 ok when db and redis are up', async () => {
    const res = await getHealth(up, up);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: 'up', redis: 'up' } });
  });

  it('returns 503 naming the failing dependency, without leaking the error', async () => {
    const res = await getHealth(down, up);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', checks: { db: 'down', redis: 'up' } });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('returns 503 when redis is down', async () => {
    const res = await getHealth(up, down);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', checks: { db: 'up', redis: 'down' } });
  });
});

describe('withTimeout', () => {
  it('resolves with the work result when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it('rejects when the work does not settle in time', async () => {
    await expect(withTimeout(new Promise<never>(() => undefined), 20)).rejects.toThrow(
      'timed out after 20ms',
    );
  });
});

describe('GET /health/live', () => {
  it('is 200 whatever the database and redis are doing, since it looks at neither', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: DB_PROBE, useValue: down },
        { provide: REDIS_PROBE, useValue: down },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const server = app.getHttpServer() as Server;
      const live = await request(server).get('/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
      // while the readiness check, on the same app, says it cannot work
      expect((await request(server).get('/health')).status).toBe(503);
    } finally {
      await app.close();
    }
  });
});
