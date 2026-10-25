import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { AdminGuard, adminRequired } from './admin.guard.js';
import { AuthModule } from './auth.module.js';
import {
  COOKIE_NAME,
  cookieValue,
  isAuthorised,
  isOpenPath,
  MIN_TOKEN_LENGTH,
  safeEqual,
  sessionValue,
} from './session.js';

const TOKEN = 'a-long-enough-admin-token-1';

describe('sessionValue', () => {
  it('is a fixed hash of the token: stable, hex, and never the token itself', () => {
    const value = sessionValue(TOKEN);
    expect(value).toBe(sessionValue(TOKEN));
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toContain(TOKEN);
  });
  it('differs for another token, so a cookie from one deployment is worthless on another', () => {
    expect(sessionValue(TOKEN)).not.toBe(sessionValue(`${TOKEN}x`));
  });
});

describe('safeEqual', () => {
  it('compares text, whatever its length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('cookieValue', () => {
  it.each([
    ['a=1; ziro_admin=xyz; b=2', 'xyz'],
    ['ziro_admin=xyz', 'xyz'],
    ['  ziro_admin = xyz ;b=2', 'xyz'],
    ['ziro_admin=a=b', 'a=b'],
    ['other=1', null],
    ['', null],
    ['ziro_admin_extra=1', null],
  ])('%j gives %j', (header, expected) => {
    expect(cookieValue(header, COOKIE_NAME)).toBe(expected);
  });
  it('is null with no header', () => {
    expect(cookieValue(undefined, COOKIE_NAME)).toBeNull();
  });
});

describe('isAuthorised', () => {
  const good = `${COOKIE_NAME}=${sessionValue(TOKEN)}`;
  it('accepts the session cookie', () => {
    expect(isAuthorised({ cookie: good, authorization: undefined }, TOKEN)).toBe(true);
    expect(isAuthorised({ cookie: `x=1; ${good}`, authorization: undefined }, TOKEN)).toBe(true);
  });
  it('accepts a bearer token', () => {
    expect(isAuthorised({ cookie: undefined, authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });
  it.each([
    [{ cookie: undefined, authorization: undefined }],
    [
      {
        cookie: `${COOKIE_NAME}=${sessionValue('another-token-entirely')}`,
        authorization: undefined,
      },
    ],
    [{ cookie: `${COOKIE_NAME}=${TOKEN}`, authorization: undefined }], // the raw token is not a session
    [{ cookie: undefined, authorization: 'Bearer wrong' }],
    [{ cookie: undefined, authorization: TOKEN }], // no "Bearer "
    [{ cookie: undefined, authorization: 'Basic abc' }],
    [{ cookie: `${COOKIE_NAME}=`, authorization: 'Bearer ' }],
  ])('refuses %j', (credentials) => {
    expect(isAuthorised(credentials, TOKEN)).toBe(false);
  });
});

describe('isOpenPath', () => {
  it.each(['/health', '/health/live', '/auth/status', '/auth/login', '/auth'])('%s is open', (p) =>
    expect(isOpenPath(p)).toBe(true),
  );
  it.each(['/runs', '/demo', '/razorpay/status', '/healthy', '/authx', '/runs/health'])(
    '%s is not',
    (p) => expect(isOpenPath(p)).toBe(false),
  );
});

describe('adminRequired', () => {
  it('needs a token and a private deployment', () => {
    expect(adminRequired({ ADMIN_TOKEN: TOKEN, DEMO_MODE: false })).toBe(true);
    expect(adminRequired({ ADMIN_TOKEN: undefined, DEMO_MODE: false })).toBe(false);
    expect(adminRequired({ ADMIN_TOKEN: TOKEN, DEMO_MODE: true })).toBe(false);
  });
});

// --- the boot rules ----------------------------------------------------------------------------------

const baseEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5433/ziro',
  REDIS_URL: 'redis://localhost:6379',
  RAZORPAY_SOURCE: 'synthetic',
  SYNTHETIC_DATA_DIR: 'data/demo',
  AGENT_HARNESS: 'loop',
  AUTO_ACCEPT_ENABLED: 'false',
  AUTO_ACCEPT_MAX_PAISE: '0',
  DEMO_MODE: 'false',
  DAILY_LLM_BUDGET_USD: '5',
  AGENT_KILL_SWITCH: 'false',
  ...over,
});

describe('ADMIN_TOKEN at boot', () => {
  it('is optional: blank or missing leaves the app open', () => {
    expect(loadEnv(baseEnv()).ADMIN_TOKEN).toBeUndefined();
    expect(loadEnv(baseEnv({ ADMIN_TOKEN: '' })).ADMIN_TOKEN).toBeUndefined();
  });
  it(`must be at least ${MIN_TOKEN_LENGTH} characters`, () => {
    expect(() => loadEnv(baseEnv({ ADMIN_TOKEN: 'short' }))).toThrow(/ADMIN_TOKEN.*at least 16/);
    expect(loadEnv(baseEnv({ ADMIN_TOKEN: TOKEN })).ADMIN_TOKEN).toBe(TOKEN);
  });
  it('refuses to boot with DEMO_MODE=true, rather than look protected and not be', () => {
    expect(() => loadEnv(baseEnv({ ADMIN_TOKEN: TOKEN, DEMO_MODE: 'true' }))).toThrow(
      /ADMIN_TOKEN.*no effect while DEMO_MODE=true/,
    );
  });
});

// --- the guard, on real routes -----------------------------------------------------------------------

@Controller()
class Probe {
  @Get('runs')
  runs() {
    return { secret: 'data' };
  }
  @Get('health')
  health() {
    return { status: 'ok' };
  }
  @Post('runs')
  make() {
    return { made: true };
  }
}

@Module({ controllers: [Probe] })
class ProbeModule {}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(over: Record<string, string> = {}) {
  const env = loadEnv(baseEnv(over));
  const built = (
    await Test.createTestingModule({
      imports: [ConfigModule.forRoot(env), AuthModule, ProbeModule],
      providers: [{ provide: APP_GUARD, useClass: AdminGuard }],
    }).compile()
  ).createNestApplication();
  await built.init();
  app = built;
  return () => request(built.getHttpServer() as Server);
}

describe('with an admin token set', () => {
  it('refuses data without it, but leaves health and sign-in open', async () => {
    const api = await boot({ ADMIN_TOKEN: TOKEN });
    expect((await api().get('/runs')).status).toBe(401);
    expect((await api().post('/runs')).status).toBe(401);
    expect((await api().get('/runs')).body).toMatchObject({ error: 'admin_required' });
    expect((await api().get('/health')).status).toBe(200);
    const status = await api().get('/auth/status');
    expect(status.body).toEqual({ required: true, authenticated: false });
  });

  it('lets a script in with a bearer token', async () => {
    const api = await boot({ ADMIN_TOKEN: TOKEN });
    expect((await api().get('/runs').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await api().get('/runs').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('signs a browser in with a cookie that is HttpOnly and SameSite=Strict, and works afterwards', async () => {
    const api = await boot({ ADMIN_TOKEN: TOKEN });
    const wrong = await api().post('/auth/login').send({ token: 'not-the-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const login = await api().post('/auth/login').send({ token: TOKEN });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ required: true, authenticated: true });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toContain(`${COOKIE_NAME}=${sessionValue(TOKEN)}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(TOKEN);

    const pair = cookie.split(';')[0] ?? '';
    expect((await api().get('/runs').set('Cookie', pair)).status).toBe(200);
    expect((await api().get('/auth/status').set('Cookie', pair)).body).toEqual({
      required: true,
      authenticated: true,
    });
  });

  it('slows down guessing', async () => {
    const api = await boot({ ADMIN_TOKEN: TOKEN });
    for (let i = 0; i < 10; i++)
      await api()
        .post('/auth/login')
        .send({ token: `guess-${i}` });
    const eleventh = await api().post('/auth/login').send({ token: TOKEN });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers['retry-after']).toBeDefined();
  });

  it('rejects a malformed sign-in body', async () => {
    const api = await boot({ ADMIN_TOKEN: TOKEN });
    expect((await api().post('/auth/login').send({})).status).toBe(400);
    expect((await api().post('/auth/login').send({ token: TOKEN, extra: 1 })).status).toBe(400);
  });
});

describe('without an admin token', () => {
  it('changes nothing: everything is open and sign-in is not needed', async () => {
    const api = await boot();
    expect((await api().get('/runs')).status).toBe(200);
    expect((await api().get('/auth/status')).body).toEqual({
      required: false,
      authenticated: true,
    });
    expect((await api().post('/auth/login').send({ token: 'whatever-it-is-here' })).body).toEqual({
      required: false,
      authenticated: true,
    });
  });
});
