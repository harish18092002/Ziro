import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountWeb, PAY_PAGE_CSP, PAY_PAGE_PATH, SECURITY_HEADERS } from './mount-web.js';

@Controller()
class Ping {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}
@Module({ controllers: [Ping] })
class Tiny {}

let dir = '';
const apps: NestExpressApplication[] = [];
async function boot(webDir: string) {
  const app = await NestFactory.create<NestExpressApplication>(Tiny, { logger: false });
  const served = mountWeb(app, webDir);
  await app.init();
  apps.push(app);
  return { app, served };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ziro-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ziro</title><div id="root"></div>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
});
afterAll(async () => {
  for (const a of apps) await a.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mountWeb', () => {
  it('serves the console at / and its assets, next to the API on the same origin', async () => {
    const { app, served } = await boot(dir);
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    expect(served).toBe(true);
    const home = await request(server).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('<div id="root">');
    expect((await request(server).get('/app.js')).status).toBe(200);
    expect((await request(server).get('/ping')).body).toEqual({ ok: true });
  });

  it('puts the security headers on pages and on API answers alike', async () => {
    const { app } = await boot(dir);
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    for (const path of ['/', '/ping', '/missing']) {
      const res = await request(server).get(path);
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        expect(res.headers[name.toLowerCase()], `${path} ${name}`).toBe(value);
    }
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toContain('unsafe-inline');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('gives only the test-payments page the Razorpay hosts, and keeps the console and the API strict', async () => {
    writeFileSync(join(dir, 'pay.html'), '<!doctype html><title>Pay</title>');
    const { app } = await boot(dir);
    const server = app.getHttpServer() as Parameters<typeof request>[0];

    const pay = await request(server).get(PAY_PAGE_PATH);
    expect(pay.status).toBe(200);
    const csp = String(pay.headers['content-security-policy']);
    expect(csp).toBe(PAY_PAGE_CSP);
    expect(csp).toContain('https://checkout.razorpay.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/); // scripts stay strict; only styles may be inline
    expect(pay.headers['x-frame-options']).toBe('DENY');
    expect(pay.headers['x-content-type-options']).toBe('nosniff');

    for (const path of ['/', '/ping', '/app.js', '/missing', '/pay.html.bak']) {
      const res = await request(server).get(path);
      expect(res.headers['content-security-policy'], path).toBe(
        SECURITY_HEADERS['Content-Security-Policy'],
      );
    }
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toContain('razorpay');
  });

  it('serves no files, but still the API, when the console has not been built', async () => {
    const { app, served } = await boot(join(dir, 'nowhere'));
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    expect(served).toBe(false);
    expect((await request(server).get('/')).status).toBe(404);
    expect((await request(server).get('/ping')).status).toBe(200);
  });

  it('trusts one proxy hop, so the client address is the forwarded one', async () => {
    const { app } = await boot(dir);
    expect(app.getHttpAdapter().getInstance().get('trust proxy')).toBe(1);
  });
});
