import { readFileSync } from 'node:fs';
import Razorpay from 'razorpay';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import {
  type Collections,
  createEmulator,
  type Emulator,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
} from './razorpay.fixtures.js';
import { createSdkClient, DEFAULT_TIMEOUT_MS, type SdkClientOptions } from './sdk-client.js';

const EMPTY: Collections = { payments: [], orders: [], refunds: [], settlements: [], recon: [] };
const WINDOW = { from: 1_000, to: 2_000, count: 100, skip: 0 };

function setup(collections: Collections = EMPTY, extra: Partial<SdkClientOptions> = {}) {
  const emulator = createEmulator(collections);
  const sleeps: number[] = [];
  const client = createSdkClient({
    keyId: TEST_KEY_ID,
    keySecret: TEST_KEY_SECRET,
    adapter: emulator.adapter,
    deps: {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.999999,
    },
    ...extra,
  });
  return { emulator, client, sleeps };
}

const everything = (e: Emulator): string =>
  e.calls.map((c) => `${c.path}?${JSON.stringify(c.params)}`).join('\n');

describe('key handling (test mode only)', () => {
  it('refuses a live key, with a message that does not repeat it', () => {
    expect(() => createSdkClient({ keyId: 'rzp_live_ZZZZZZZZ1234', keySecret: 's' })).toThrow(
      RazorpayConfigError,
    );
    expect(() => createSdkClient({ keyId: 'rzp_live_ZZZZZZZZ1234', keySecret: 's' })).toThrow(
      /forbidden/,
    );
    try {
      createSdkClient({ keyId: 'rzp_live_ZZZZZZZZ1234', keySecret: 's' });
    } catch (error) {
      expect((error as Error).message).not.toContain('ZZZZZZZZ1234');
    }
  });

  it('refuses anything that is not a rzp_test_ key, and a missing secret', () => {
    for (const keyId of [
      '',
      'abc',
      'rzp_TEST_x',
      'RZP_LIVE_X',
      'rzp_test_',
      'rzp_test_has space',
    ]) {
      expect(() => createSdkClient({ keyId, keySecret: 's' }), keyId).toThrow(RazorpayConfigError);
    }
    expect(() => createSdkClient({ keyId: TEST_KEY_ID, keySecret: '  ' })).toThrow(/secret/);
  });
});

describe('the SDK internals this adapter relies on (canary)', () => {
  it('is pinned to the exact version it was written against', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['razorpay']).toBe('2.9.8');
    expect(Razorpay.VERSION).toBe('2.9.8');
  });

  it('still exposes an axios instance at api.rq with a hard-coded host and no timeout', () => {
    const rzp = new Razorpay({ key_id: TEST_KEY_ID, key_secret: TEST_KEY_SECRET });
    const rq = (
      rzp as unknown as {
        api: {
          rq: {
            defaults: { baseURL: string; timeout: number };
            interceptors: { response: { use: unknown } };
          };
        };
      }
    ).api.rq;
    expect(rq.defaults.baseURL).toBe('https://api.razorpay.com');
    expect(rq.defaults.timeout).toBe(0);
    expect(typeof rq.interceptors.response.use).toBe('function');
  });
});

describe('requests', () => {
  it('sends each call to the documented path with the documented parameters and basic auth', async () => {
    const { emulator, client } = setup();
    await client.listPayments(WINDOW);
    await client.listOrders(WINDOW);
    await client.listRefunds(WINDOW);
    await client.listSettlements(WINDOW);
    await client.settlementRecon({ year: 2026, month: 10, day: 12, count: 1000, skip: 0 });
    await client.fetchOrder('order_X').catch(() => undefined);

    expect(emulator.calls.map((c) => c.path)).toEqual([
      '/v1/payments',
      '/v1/orders',
      '/v1/refunds',
      '/v1/settlements',
      '/v1/settlements/recon/combined',
      '/v1/orders/order_X',
    ]);
    expect(emulator.calls[0]?.params).toMatchObject({ from: 1000, to: 2000, count: 100, skip: 0 });
    expect(emulator.calls[4]?.params).toMatchObject({
      year: 2026,
      month: 10,
      day: 12,
      count: 1000,
      skip: 0,
    });
    for (const call of emulator.calls) {
      expect(call.username).toBe(TEST_KEY_ID);
      expect(call.password).toBe(TEST_KEY_SECRET);
    }
  });

  it('puts a timeout on every request (the SDK has none)', async () => {
    const a = setup();
    await a.client.listPayments(WINDOW);
    expect(a.emulator.calls[0]?.timeout).toBe(DEFAULT_TIMEOUT_MS);

    const b = setup(EMPTY, { timeoutMs: 1234 });
    await b.client.listRefunds(WINDOW);
    expect(b.emulator.calls[0]?.timeout).toBe(1234);
  });

  it('returns the raw collection untouched', async () => {
    const { client } = setup({
      ...EMPTY,
      payments: [{ id: 'pay_A', created_at: 1500, anything: 'extra' }],
    });
    expect(await client.listPayments(WINDOW)).toEqual({
      entity: 'collection',
      count: 1,
      items: [{ id: 'pay_A', created_at: 1500, anything: 'extra' }],
    });
  });
});

describe('failures are classified and retried', () => {
  it.each([429, 500, 502, 503, 504])(
    'retries HTTP %i with backoff and then succeeds',
    async (status) => {
      const { emulator, client, sleeps } = setup();
      emulator.failNext(
        '/v1/payments',
        { status, body: { error: { code: 'SERVER_ERROR', description: 'try later' } } },
        { status },
      );
      await expect(client.listPayments(WINDOW)).resolves.toMatchObject({ entity: 'collection' });
      expect(emulator.calls).toHaveLength(3);
      expect(sleeps).toEqual([500, 1000]); // full-jitter ceilings with random pinned just under 1
    },
  );

  it.each(['timeout', 'reset'] as const)(
    'survives a %s: no response at all, which crashes the SDK on its own',
    async (network) => {
      const { emulator, client } = setup();
      emulator.failNext('/v1/refunds', { network });
      await expect(client.listRefunds(WINDOW)).resolves.toMatchObject({ entity: 'collection' });
      expect(emulator.calls).toHaveLength(2);
    },
  );

  it('reports a persistent network failure as a RazorpayApiError (status 0), not a TypeError', async () => {
    const { emulator, client } = setup(EMPTY, { retry: { maxAttempts: 3 } });
    emulator.failNext(
      '/v1/settlements',
      { network: 'timeout' },
      { network: 'timeout' },
      { network: 'timeout' },
    );
    const error = await client.listSettlements(WINDOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayApiError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ statusCode: 0, code: 'ECONNABORTED', attempts: 3 });
  });

  it('survives a gateway page that is HTML, not JSON', async () => {
    const { emulator, client } = setup();
    emulator.failNext('/v1/payments', {
      status: 502,
      body: '<html><body>Bad Gateway</body></html>',
    });
    await expect(client.listPayments(WINDOW)).resolves.toBeDefined();
    expect(emulator.calls).toHaveLength(2);
  });

  it('survives an error response with an empty body', async () => {
    const { emulator, client } = setup(EMPTY, { retry: { maxAttempts: 2 } });
    emulator.failNext('/v1/payments', { status: 500 }, { status: 500 });
    await expect(client.listPayments(WINDOW)).rejects.toMatchObject({
      statusCode: 500,
      code: 'BAD_RESPONSE',
      attempts: 2,
    });
  });

  it('honours a Retry-After header, which the SDK itself throws away', async () => {
    const { emulator, client, sleeps } = setup();
    emulator.failNext('/v1/payments', {
      status: 429,
      headers: { 'retry-after': '3' },
      body: { error: { code: 'TOO_MANY_REQUESTS', description: 'slow down' } },
    });
    await client.listPayments(WINDOW);
    expect(sleeps).toEqual([3000]);
  });

  it('gives up after maxAttempts and says how many it tried', async () => {
    const { emulator, client } = setup(EMPTY, { retry: { maxAttempts: 4 } });
    emulator.failNext('/v1/orders', ...Array.from({ length: 10 }, () => ({ status: 503 })));
    await expect(client.listOrders(WINDOW)).rejects.toMatchObject({ statusCode: 503, attempts: 4 });
    expect(emulator.calls).toHaveLength(4);
  });

  it.each([
    [400, 'BAD_REQUEST_ERROR'],
    [401, 'BAD_REQUEST_ERROR'],
    [404, 'BAD_REQUEST_ERROR'],
  ])(
    'does not retry HTTP %i: it surfaces the Razorpay error code and description',
    async (status, code) => {
      const { emulator, client, sleeps } = setup();
      emulator.failNext('/v1/payments', {
        status,
        body: { error: { code, description: `nope ${status}` } },
      });
      await expect(client.listPayments(WINDOW)).rejects.toMatchObject({
        statusCode: status,
        code,
        description: `nope ${status}`,
        attempts: 1,
      });
      expect(emulator.calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    },
  );

  it('the emulator itself enforces the documented count limit (so a pagination bug would show)', async () => {
    const { client } = setup();
    await expect(client.listPayments({ ...WINDOW, count: 101 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      client.settlementRecon({ year: 2026, month: 10, day: 1, count: 1001, skip: 0 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('secrets never leak', () => {
  const basic = Buffer.from(`${TEST_KEY_ID}:${TEST_KEY_SECRET}`).toString('base64');

  it('keeps the secret out of every error it can throw', async () => {
    const { emulator, client } = setup(EMPTY, { retry: { maxAttempts: 2 } });
    emulator.failNext('/v1/payments', {
      status: 401,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } },
    });
    emulator.failNext('/v1/refunds', { network: 'reset' }, { network: 'reset' });
    emulator.failNext('/v1/settlements', { status: 503 }, { status: 503 });

    for (const run of [
      () => client.listPayments(WINDOW),
      () => client.listRefunds(WINDOW),
      () => client.listSettlements(WINDOW),
    ]) {
      const error = (await run().catch((e: unknown) => e)) as Error;
      const everyField = [
        error.message,
        error.stack ?? '',
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ].join('\n');
      expect(everyField).not.toContain(TEST_KEY_SECRET);
      expect(everyField).not.toContain(basic);
      expect(everyField.toLowerCase()).not.toContain('authorization');
    }
  });

  it('never puts credentials in a request parameter', async () => {
    const { emulator, client } = setup();
    await client.listPayments(WINDOW);
    expect(everything(emulator)).not.toContain(TEST_KEY_SECRET);
  });
});
