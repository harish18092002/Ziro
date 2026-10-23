// The public demo's allowlist, as a table and then through a real app.
import type { Server } from 'node:http';
import { Controller, Delete, Get, type INestApplication, Post, Put } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { allowedInDemoMode, DemoModeGuard } from './demo-mode.guard.js';

const ID = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';

describe('allowedInDemoMode', () => {
  it.each([
    ['GET', '/runs/abc/overview'],
    ['GET', '/runs/abc/exceptions.csv'],
    ['GET', '/health'],
    ['HEAD', '/'],
    ['OPTIONS', '/demo/runs'],
    ['POST', '/demo/runs'],
    ['POST', '/demo/runs/'],
    ['POST', '/demo/reset'],
    ['POST', `/proposals/${ID}/approve`],
    ['POST', `/proposals/${ID}/reject`],
    ['post', '/demo/runs'],
  ])('allows %s %s', (method, path) => {
    expect(allowedInDemoMode(method, path)).toBe(true);
  });

  it.each([
    ['POST', '/runs'],
    ['POST', '/runs/demo'],
    ['POST', `/runs/${ID}/import/ledger`],
    ['POST', `/runs/${ID}/import/bank`],
    ['POST', `/runs/${ID}/import/razorpay`],
    ['POST', `/runs/${ID}/match`],
    ['POST', `/runs/${ID}/verify`],
    ['POST', `/runs/${ID}/investigate`],
    ['POST', '/demo/runs/extra'],
    ['POST', '/demo'],
    ['POST', '/proposals/not-a-uuid/approve'],
    ['POST', `/proposals/${ID}/approve/extra`],
    ['POST', `/proposals/${ID}`],
    ['PUT', '/demo/runs'],
    ['PATCH', '/runs/abc'],
    ['DELETE', `/proposals/${ID}/approve`],
  ])('refuses %s %s', (method, path) => {
    expect(allowedInDemoMode(method, path)).toBe(false);
  });
});

@Controller()
class Probe {
  @Get('runs/x') read() {
    return { ok: true };
  }
  @Post('runs') create() {
    return { created: true };
  }
  @Post('demo/runs') start() {
    return { started: true };
  }
  @Put('runs/x') put() {
    return { put: true };
  }
  @Delete('runs/x') del() {
    return { del: true };
  }
  @Post(`runs/${ID}/investigate`) investigate() {
    return { spent: true };
  }
}

async function boot(demoMode: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ DEMO_MODE: demoMode } as Env)],
    controllers: [Probe],
    providers: [{ provide: APP_GUARD, useClass: DemoModeGuard }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('the guard in a real app', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const server = () => (app as INestApplication).getHttpServer() as Server;

  it('in DEMO_MODE lets a visitor read and start a run, and nothing that creates work or spends', async () => {
    app = await boot(true);
    expect((await request(server()).get('/runs/x')).status).toBe(200);
    expect((await request(server()).post('/demo/runs')).status).toBe(201);
    for (const res of [
      await request(server()).post('/runs'),
      await request(server()).post(`/runs/${ID}/investigate`),
      await request(server()).put('/runs/x'),
      await request(server()).delete('/runs/x'),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'disabled_in_demo' });
    }
  });

  it('outside DEMO_MODE changes nothing', async () => {
    app = await boot(false);
    expect((await request(server()).post('/runs')).status).toBe(201);
    expect((await request(server()).post(`/runs/${ID}/investigate`)).status).toBe(201);
    expect((await request(server()).delete('/runs/x')).status).toBe(200);
  });
});
