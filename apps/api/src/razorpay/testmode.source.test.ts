import { istDayBounds } from '@ziro/core/time';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError, RazorpayResponseError } from './errors.js';
import {
  type Collections,
  createEmulator,
  docsDerivedCollections,
  RUN_ID,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
} from './razorpay.fixtures.js';
import { createSdkClient, type RazorpayClient } from './sdk-client.js';
import {
  type Entity,
  type FetchResult,
  type RazorpaySource,
  summarizeProvenance,
} from './source.js';
import { TestModeSource, type TestModeSourceOptions } from './testmode.source.js';

const DAY = { from: '2026-10-08', to: '2026-10-08' };
const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const EMPTY: Collections = { payments: [], orders: [], refunds: [], settlements: [], recon: [] };
const T0 = istDayBounds('2026-10-08').fromEpoch + 3600;

const pad = (n: number): string => String(n).padStart(14, '0');
const rawPayment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `pay_${pad(n)}`,
  entity: 'payment',
  amount: 10000 + n,
  status: 'captured',
  order_id: null,
  method: 'upi',
  amount_refunded: 0,
  captured: true,
  fee: 200,
  tax: 31,
  created_at: T0 + n,
  ...over,
});

/** A fallback that records which of its methods were used and returns a labelled, empty answer. */
function spyFallback() {
  const used: string[] = [];
  const answer = <T>(entity: Entity, method: string): Promise<FetchResult<T>> => {
    used.push(method);
    return Promise.resolve({
      source: 'synthetic',
      items: [],
      provenance: { entity, source: 'synthetic', reason: 'ok', requests: 0, warnings: [] },
    });
  };
  const fallback: RazorpaySource = {
    fetchPayments: () => answer('payments', 'payments'),
    fetchRefunds: () => answer('refunds', 'refunds'),
    fetchSettlements: () => answer('settlements', 'settlements'),
    fetchSettlementRecon: () => answer('settlement_recon', 'recon'),
  };
  return { fallback, used };
}

function setup(collections: Collections, options: Partial<TestModeSourceOptions> = {}) {
  const emulator = createEmulator(collections);
  const { fallback, used } = spyFallback();
  const client = createSdkClient({
    keyId: TEST_KEY_ID,
    keySecret: TEST_KEY_SECRET,
    adapter: emulator.adapter,
    retry: { maxAttempts: 2 },
    deps: { sleep: () => Promise.resolve(), random: () => 0 },
  });
  const source = new TestModeSource({ runId: RUN_ID, client, fallback, ...options });
  const callsTo = (prefix: string) => emulator.calls.filter((c) => c.path.startsWith(prefix));
  /** Calls to exactly this endpoint, not to the endpoints beneath it. */
  const callsToExactly = (path: string) => emulator.calls.filter((c) => c.path === path);
  return { emulator, source, used, callsTo, callsToExactly };
}

describe('pagination', () => {
  it('walks count/skip to the end: 250 payments are 3 pages of up to 100', async () => {
    const payments = Array.from({ length: 250 }, (_, i) => rawPayment(i));
    const { source, callsTo } = setup({ ...EMPTY, payments });
    const result = await source.fetchPayments(DAY);
    expect(result.items).toHaveLength(250);
    expect(new Set(result.items.map((i) => i.record.paymentId)).size).toBe(250);
    expect(callsTo('/v1/payments').map((c) => [c.params['count'], c.params['skip']])).toEqual([
      [100, 0],
      [100, 100],
      [100, 200],
    ]);
    expect(result.provenance.requests).toBe(3);
  });

  it('stops after a final empty page when the total is an exact multiple of the page size', async () => {
    const { source, callsTo } = setup({
      ...EMPTY,
      payments: Array.from({ length: 200 }, (_, i) => rawPayment(i)),
    });
    expect((await source.fetchPayments(DAY)).items).toHaveLength(200);
    expect(callsTo('/v1/payments')).toHaveLength(3);
  });

  it('uses the documented larger page for the recon report: 1500 lines are 2 calls of up to 1000', async () => {
    const day = '2026-10-12';
    const settledAt = istDayBounds(day).fromEpoch + 7 * 3600;
    const recon = Array.from({ length: 1500 }, (_, i) => ({
      entity_id: `pay_${pad(i)}`,
      type: 'payment',
      debit: 0,
      credit: 98,
      amount: 100,
      fee: 2,
      tax: 0,
      settled_at: settledAt,
      created_at: settledAt - 86_400,
      settlement_id: 'setl_Single00000001',
    }));
    const { source, callsTo } = setup({
      ...EMPTY,
      settlements: [
        { id: 'setl_Single00000001', amount: 1, status: 'processed', created_at: settledAt },
      ],
      recon,
    });
    const result = await source.fetchSettlementRecon(day);
    expect(result.items).toHaveLength(1500);
    expect(
      callsTo('/v1/settlements/recon').map((c) => [c.params['count'], c.params['skip']]),
    ).toEqual([
      [1000, 0],
      [1000, 1000],
    ]);
  });

  it('drops a record that appears on two overlapping pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawPayment(i));
    const page2 = Array.from({ length: 51 }, (_, i) => rawPayment(i + 99)); // 99 and 100... overlap on id 99
    const pages = [page1, page2];
    const client = stubClient({ listPayments: (q) => collection(pages[q.skip / 100] ?? []) });
    const source = new TestModeSource({ runId: RUN_ID, client, fallback: spyFallback().fallback });
    const result = await source.fetchPayments(DAY);
    expect(result.items).toHaveLength(150);
    expect(new Set(result.items.map((i) => i.record.paymentId)).size).toBe(150);
  });

  it('refuses to page forever when the server ignores skip', async () => {
    const page = Array.from({ length: 100 }, (_, i) => rawPayment(i));
    const client = stubClient({ listPayments: () => collection(page) });
    const source = new TestModeSource({
      runId: RUN_ID,
      client,
      fallback: spyFallback().fallback,
      maxPages: 5,
    });
    await expect(source.fetchPayments(DAY)).rejects.toThrow(/still paging after 5 pages/);
  });

  it('sends the IST day bounds as from/to', async () => {
    const { source, callsTo } = setup({ ...EMPTY, payments: [rawPayment(1)] });
    await source.fetchPayments({ from: '2026-10-07', to: '2026-10-09' });
    const bounds = {
      from: istDayBounds('2026-10-07').fromEpoch,
      to: istDayBounds('2026-10-09').toEpoch,
    };
    expect(callsTo('/v1/payments')[0]?.params).toMatchObject(bounds);
  });

  it('keeps only records inside the range even if the server returns others', async () => {
    const outside = rawPayment(2, { created_at: istDayBounds('2026-10-20').fromEpoch });
    const client = stubClient({ listPayments: () => collection([rawPayment(1), outside]) });
    const source = new TestModeSource({ runId: RUN_ID, client, fallback: spyFallback().fallback });
    expect((await source.fetchPayments(DAY)).items.map((i) => i.record.paymentId)).toEqual([
      `pay_${pad(1)}`,
    ]);
  });
});

describe('what is real and what falls back', () => {
  it('uses test-mode payments, labelled razorpay_testmode, when there are some', async () => {
    const { source, used } = setup(docsDerivedCollections());
    const result = await source.fetchPayments(OCTOBER);
    expect(result.source).toBe('razorpay_testmode');
    expect(result.provenance.reason).toBe('ok');
    expect(result.items.length).toBe(5);
    expect(result.items.every((i) => i.record.source === 'razorpay_testmode')).toBe(true);
    expect(used).toEqual([]);
  });

  it('falls back to synthetic payments when test mode has none, and says why', async () => {
    const { source, used } = setup(EMPTY);
    const result = await source.fetchPayments(OCTOBER);
    expect(used).toEqual(['payments']);
    expect(result.source).toBe('synthetic');
    expect(result.provenance).toMatchObject({
      entity: 'payments',
      source: 'synthetic',
      reason: 'test-mode-empty',
      requests: 1,
    });
  });

  it('refunds follow payments: synthetic payments mean synthetic refunds, with no refund call to Razorpay', async () => {
    const { source, used, callsTo } = setup(EMPTY);
    const result = await source.fetchRefunds(OCTOBER);
    expect(result.source).toBe('synthetic');
    expect(result.provenance.reason).toBe('follows-payments');
    expect(used).toEqual(['payments', 'refunds']);
    expect(callsTo('/v1/refunds')).toHaveLength(0);
  });

  it('real payments with no refunds is a true answer: empty, still real, no fallback', async () => {
    const { source, used } = setup({ ...docsDerivedCollections(), refunds: [] });
    const result = await source.fetchRefunds(OCTOBER);
    expect(result.source).toBe('razorpay_testmode');
    expect(result.items).toHaveLength(0);
    expect(used).toEqual([]);
  });

  it('returns real refunds alongside real payments', async () => {
    const { source } = setup(docsDerivedCollections());
    const result = await source.fetchRefunds(OCTOBER);
    expect(result.source).toBe('razorpay_testmode');
    expect(result.items.map((i) => i.record.refundId)).toEqual(['rfnd_DfjjhJC6eDvUAi']);
  });

  it('falls back for settlements when test mode has none, even though payments are real', async () => {
    const { source, used } = setup({ ...docsDerivedCollections(), settlements: [], recon: [] });
    const payments = await source.fetchPayments(OCTOBER);
    const settlements = await source.fetchSettlements(OCTOBER);
    expect(payments.source).toBe('razorpay_testmode');
    expect(settlements.source).toBe('synthetic');
    expect(settlements.provenance.reason).toBe('test-mode-empty');
    expect(used).toEqual(['settlements']);

    const summary = summarizeProvenance([payments.provenance, settlements.provenance]);
    expect(summary.mixed).toBe(true);
    expect(summary.bySource).toEqual({
      razorpay_testmode: ['payments'],
      synthetic: ['settlements'],
    });
  });

  it('uses real settlements when test mode does have them', async () => {
    const { source, used } = setup(docsDerivedCollections());
    const result = await source.fetchSettlements(OCTOBER);
    expect(result.source).toBe('razorpay_testmode');
    expect(result.items.map((i) => i.record.settlementId)).toEqual(['setl_DGlQ1Rj8os78Ec']);
    expect(used).toEqual([]);
  });

  describe('the recon report follows settlements, month by month', () => {
    it('is synthetic when test mode has no settlements that month, after exactly one probe', async () => {
      const { source, used, callsTo, callsToExactly } = setup({
        ...docsDerivedCollections(),
        settlements: [],
        recon: [],
      });
      const a = await source.fetchSettlementRecon('2026-10-12');
      const b = await source.fetchSettlementRecon('2026-10-13');
      expect(a.source).toBe('synthetic');
      expect(a.provenance.reason).toBe('test-mode-empty');
      expect(b.source).toBe('synthetic');
      expect(used).toEqual(['recon', 'recon']);
      expect(callsToExactly('/v1/settlements')).toHaveLength(1); // the month was probed once and remembered
      expect(callsTo('/v1/settlements/recon')).toHaveLength(0);
    });

    it('is real, including real emptiness, when test mode settles that month', async () => {
      const { source, used } = setup(docsDerivedCollections());
      const busy = await source.fetchSettlementRecon('2026-10-12');
      expect(busy.source).toBe('razorpay_testmode');
      expect(busy.items.map((i) => i.record.itemType).sort()).toEqual([
        'adjustment',
        'payment',
        'refund',
        'transfer',
      ]);

      const quiet = await source.fetchSettlementRecon('2026-10-20');
      expect(quiet.source).toBe('razorpay_testmode'); // nothing settled that day is a true answer, not a gap
      expect(quiet.items).toHaveLength(0);
      expect(used).toEqual([]);
    });

    it('decides per calendar month', async () => {
      const { source, callsToExactly } = setup(docsDerivedCollections());
      expect((await source.fetchSettlementRecon('2026-10-12')).source).toBe('razorpay_testmode');
      expect((await source.fetchSettlementRecon('2026-11-03')).source).toBe('synthetic'); // no November settlements
      expect(callsToExactly('/v1/settlements')).toHaveLength(2); // one probe per month
      expect(callsToExactly('/v1/settlements/recon/combined')).toHaveLength(1); // October only
    });
  });

  it('asks Razorpay only once for the same range', async () => {
    const { source, callsTo } = setup(docsDerivedCollections());
    await source.fetchPayments(OCTOBER);
    await source.fetchPayments(OCTOBER);
    await source.fetchRefunds(OCTOBER);
    expect(callsTo('/v1/payments')).toHaveLength(1);
  });
});

describe('errors never fall back to synthetic data', () => {
  const cases: [string, number, string][] = [
    ['bad credentials on payments', 401, '/v1/payments'],
    ['a forbidden endpoint', 403, '/v1/payments'],
    ['a server fault that outlasts the retries', 503, '/v1/payments'],
  ];

  it.each(cases)('surfaces %s', async (_name, status, path) => {
    const { emulator, source, used } = setup(docsDerivedCollections());
    emulator.failNext(
      path,
      ...Array.from({ length: 5 }, () => ({
        status,
        body: { error: { code: 'X', description: 'no' } },
      })),
    );
    await expect(source.fetchPayments(OCTOBER)).rejects.toMatchObject({ statusCode: status });
    expect(used).toEqual([]);
  });

  it('surfaces an error on the settlements endpoint instead of hiding it behind synthetic data', async () => {
    const { emulator, source, used } = setup(docsDerivedCollections());
    emulator.failNext('/v1/settlements', {
      status: 400,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'not enabled' } },
    });
    await expect(source.fetchSettlements(OCTOBER)).rejects.toBeInstanceOf(RazorpayApiError);
    expect(used).toEqual([]);
  });

  it('rejects a malformed response rather than guessing', async () => {
    const client = stubClient({ listPayments: () => Promise.resolve({ nope: true }) });
    const source = new TestModeSource({ runId: RUN_ID, client, fallback: spyFallback().fallback });
    await expect(source.fetchPayments(DAY)).rejects.toBeInstanceOf(RazorpayResponseError);
  });
});

describe('a list that fails part-way', () => {
  const unavailable = {
    status: 503,
    body: { error: { code: 'SERVER_ERROR', description: 'down' } },
  };
  const secondPageOnwards = (params: Record<string, unknown>) => Number(params['skip']) >= 100;

  it('keeps the pages it already has and says the list is incomplete', async () => {
    const payments = Array.from({ length: 250 }, (_, i) => rawPayment(i));
    const { emulator, source, used } = setup({ ...EMPTY, payments });
    emulator.failWhen('/v1/payments', secondPageOnwards, unavailable);

    const result = await source.fetchPayments(DAY);

    expect(result.items).toHaveLength(100);
    expect(result.source).toBe('razorpay_testmode');
    expect(result.provenance.reason).toBe('ok');
    expect(result.provenance.incomplete).toHaveLength(1);
    expect(result.provenance.incomplete?.[0]).toMatchObject({ what: 'payments', fetched: 100 });
    expect(result.provenance.incomplete?.[0]?.reason).toMatch(
      /503 SERVER_ERROR.*\(after 2 tries\)/,
    );
    // It did not quietly swap in synthetic data for the part it could not get.
    expect(used).toEqual([]);
  });

  it('records nothing as incomplete when every page arrives', async () => {
    const { source } = setup({
      ...EMPTY,
      payments: Array.from({ length: 150 }, (_, i) => rawPayment(i)),
    });
    expect((await source.fetchPayments(DAY)).provenance.incomplete).toBeUndefined();
  });

  it('still fails when the FIRST page fails: there is nothing to keep', async () => {
    const { emulator, source, used } = setup({
      ...EMPTY,
      payments: Array.from({ length: 250 }, (_, i) => rawPayment(i)),
    });
    emulator.failWhen('/v1/payments', () => true, unavailable);
    await expect(source.fetchPayments(DAY)).rejects.toMatchObject({ statusCode: 503 });
    expect(used).toEqual([]);
  });

  it('still fails when a later page is unreadable: that is not an outage', async () => {
    const { emulator, source } = setup({
      ...EMPTY,
      payments: Array.from({ length: 250 }, (_, i) => rawPayment(i)),
    });
    emulator.failWhen('/v1/payments', secondPageOnwards, { status: 200, body: { nope: true } });
    await expect(source.fetchPayments(DAY)).rejects.toBeInstanceOf(RazorpayResponseError);
  });

  it('still fails when a later page dies of something that is not a Razorpay answer: a bug is not an outage', async () => {
    let calls = 0;
    const client = stubClient({
      listPayments: () => {
        calls += 1;
        return calls === 1
          ? collection(Array.from({ length: 100 }, (_, i) => rawPayment(i)))
          : Promise.reject(new TypeError('x is not a function'));
      },
    });
    const source = new TestModeSource({ runId: RUN_ID, client, fallback: spyFallback().fallback });
    await expect(source.fetchPayments(DAY)).rejects.toBeInstanceOf(TypeError);
  });

  it('does not stop on a 4xx: a refused request is not a transient failure of the list', async () => {
    const { emulator, source } = setup({
      ...EMPTY,
      payments: Array.from({ length: 250 }, (_, i) => rawPayment(i)),
    });
    emulator.failWhen('/v1/payments', secondPageOnwards, {
      status: 400,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'bad' } },
    });
    // The list is incomplete all the same, and says why: the caller decides what that means.
    const result = await source.fetchPayments(DAY);
    expect(result.items).toHaveLength(100);
    expect(result.provenance.incomplete?.[0]?.reason).toContain('400');
  });

  it('names the orders list when it is the one that stopped, not the payments', async () => {
    const T = istDayBounds('2026-10-08').fromEpoch;
    const orders = Array.from({ length: 150 }, (_, i) => ({
      id: `order_${String(i).padStart(14, '0')}`,
      entity: 'order',
      receipt: `ORD-${i}`,
      created_at: T + 3600 + i,
    }));
    const payments = [rawPayment(1, { order_id: orders[0]?.id })];
    const { emulator, source } = setup({ ...EMPTY, payments, orders });
    emulator.failWhen('/v1/orders', secondPageOnwards, unavailable);

    const result = await source.fetchPayments(DAY);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.record.receipt).toBe('ORD-0'); // it was on the first page
    expect(result.provenance.incomplete?.map((i) => [i.what, i.fetched])).toEqual([
      ['orders', 100],
    ]);
  });
});

describe('order receipts (they live on the order, not the payment)', () => {
  const T = istDayBounds('2026-10-08').fromEpoch;
  const order = (id: string, receipt: string | null, createdAt: number) => ({
    id,
    entity: 'order',
    receipt,
    created_at: createdAt,
  });

  it('resolves receipts from one orders listing', async () => {
    const { source, callsTo } = setup(docsDerivedCollections());
    const { items } = await source.fetchPayments(OCTOBER);
    const receipts = Object.fromEntries(items.map((i) => [i.record.paymentId, i.record.receipt]));
    expect(receipts['pay_NetBank0000001']).toBe('ORD-5001');
    expect(receipts['pay_WalletRefund001']).toBe('ORD-5004');
    expect(receipts['pay_Authorized0001']).toBeNull();
    expect(callsTo('/v1/orders/')).toHaveLength(0); // no one-by-one lookups needed
  });

  it('fetches an order created before the lookback window individually', async () => {
    const old = order('order_OldOrder000001', 'ORD-OLD', T - 30 * 86_400);
    const { source, callsTo } = setup({
      ...EMPTY,
      payments: [rawPayment(1, { order_id: 'order_OldOrder000001' })],
      orders: [old],
    });
    const { items } = await source.fetchPayments(DAY);
    expect(items[0]?.record.receipt).toBe('ORD-OLD');
    expect(callsTo('/v1/orders/').map((c) => c.path)).toEqual(['/v1/orders/order_OldOrder000001']);
  });

  it('warns, and leaves the receipt empty, for an order Razorpay cannot find', async () => {
    const { source } = setup({
      ...EMPTY,
      payments: [rawPayment(1, { order_id: 'order_Missing0000001' })],
    });
    const result = await source.fetchPayments(DAY);
    expect(result.items[0]?.record.receipt).toBeNull();
    expect(result.provenance.warnings).toEqual([
      'order order_Missing0000001 was not found, so its payment has no receipt',
    ]);
  });

  it('refuses to make a flood of single lookups', async () => {
    const orders = [1, 2, 3].map((n) =>
      order(`order_Old${pad(n).slice(3)}`, `R${n}`, T - 30 * 86_400),
    );
    const payments = orders.map((o, i) => rawPayment(i, { order_id: o.id }));
    const { source } = setup({ ...EMPTY, payments, orders }, { maxOrderLookups: 2 });
    await expect(source.fetchPayments(DAY)).rejects.toThrow(/widen orderLookbackDays/);
  });
});

// --- helpers --------------------------------------------------------------------------------------

const collection = (items: unknown[]) =>
  Promise.resolve({ entity: 'collection', count: items.length, items });

/** A client for tests that need to control exactly what comes back; anything unlisted throws. */
function stubClient(overrides: Partial<RazorpayClient>): RazorpayClient {
  const unexpected = (name: string) => () =>
    Promise.reject(new Error(`unexpected call to ${name}`));
  return {
    listPayments: unexpected('listPayments'),
    listOrders: () => collection([]),
    fetchOrder: unexpected('fetchOrder'),
    listRefunds: unexpected('listRefunds'),
    listSettlements: unexpected('listSettlements'),
    settlementRecon: unexpected('settlementRecon'),
    ...overrides,
  };
}
