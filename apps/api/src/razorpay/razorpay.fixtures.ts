// Test support for the Razorpay layer: an emulator of Razorpay's list API, a generated synthetic
// dataset on disk, and small samples transcribed from Razorpay's documentation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { istBusinessDate, istDayBounds } from '@ziro/core/time';
import { generate, resolveConfig, type PresetName, writeDataset } from '@ziro/datagen';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { readFileSync } from 'node:fs';

export const RUN_ID = '00000000-0000-4000-8000-0000000000aa';
export const TEST_KEY_ID = 'rzp_test_AbCdEf123456';
export const TEST_KEY_SECRET = 'super-secret-test-value';

export interface Collections {
  payments: unknown[];
  orders: unknown[];
  refunds: unknown[];
  settlements: unknown[];
  recon: unknown[];
}

export type Outcome =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { network: 'timeout' | 'reset' };

export interface RecordedCall {
  readonly path: string;
  readonly timeout: number | undefined;
  readonly params: Record<string, unknown>;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

export interface Emulator {
  readonly adapter: AxiosAdapter;
  readonly calls: RecordedCall[];
  /** The next calls whose path starts with `prefix` get these outcomes, in order, before normal service. */
  failNext(prefix: string, ...outcomes: Outcome[]): void;
  /**
   * Every call whose path starts with `prefix` and whose query parameters satisfy `when` gets this outcome,
   * for as long as the emulator lives: "page two of the payments always fails".
   */
  failWhen(
    prefix: string,
    when: (params: Record<string, unknown>) => boolean,
    outcome: Outcome,
  ): void;
}

type Item = Record<string, unknown>;
const asItems = (list: unknown[]): Item[] => list as Item[];

const apiError = (status: number, description: string) => ({
  status,
  body: { error: { code: 'BAD_REQUEST_ERROR', description } },
});

/**
 * Serves Razorpay's list endpoints from in-memory collections with the documented rules: `count`
 * defaults to 10 and is capped (100, or 1000 for recon), `skip` offsets, `from`/`to` filter on
 * `created_at`, and the recon report filters by the IST day a line was settled.
 */
export function createEmulator(collections: Collections): Emulator {
  const calls: RecordedCall[] = [];
  const queued = new Map<string, Outcome[]>();
  const rules: {
    prefix: string;
    when: (params: Record<string, unknown>) => boolean;
    outcome: Outcome;
  }[] = [];

  const respond = (
    config: InternalAxiosRequestConfig,
    status: number,
    data: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = { data, status, statusText: String(status), headers, config, request: {} };
    if (status >= 200 && status < 300) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response,
    );
  };

  const outcome = (config: InternalAxiosRequestConfig, o: Outcome) => {
    if ('network' in o) {
      throw o.network === 'timeout'
        ? new AxiosError('timeout of 15000ms exceeded', AxiosError.ECONNABORTED, config)
        : new AxiosError('read ECONNRESET', 'ECONNRESET', config);
    }
    return respond(config, o.status, o.body, o.headers);
  };

  const page = (
    config: InternalAxiosRequestConfig,
    list: Item[],
    max: number,
    pick: (item: Item) => number,
  ) => {
    const p = (config.params ?? {}) as Record<string, unknown>;
    const count = p['count'] === undefined ? 10 : Number(p['count']);
    const skip = p['skip'] === undefined ? 0 : Number(p['skip']);
    if (!Number.isInteger(count) || count < 1 || count > max) {
      const e = apiError(400, `count must be between 1 and ${max}`);
      return respond(config, e.status, e.body);
    }
    const from = p['from'] === undefined ? -Infinity : Number(p['from']);
    const to = p['to'] === undefined ? Infinity : Number(p['to']);
    const matching = list.filter((item) => pick(item) >= from && pick(item) <= to);
    const items = matching.slice(skip, skip + count);
    return respond(config, 200, { entity: 'collection', count: items.length, items });
  };

  const adapter: AxiosAdapter = (config) => {
    const path = String(config.url);
    const params = { ...((config.params ?? {}) as Record<string, unknown>) };
    calls.push({
      path,
      timeout: config.timeout,
      params,
      username: config.auth?.username,
      password: config.auth?.password,
    });

    const queue = [...queued.entries()].find(([prefix]) => path.startsWith(prefix));
    const rule = rules.find((r) => path.startsWith(r.prefix) && r.when(params));
    const next = rule?.outcome ?? queue?.[1].shift();
    const run = (): ReturnType<typeof respond> => {
      if (next) return outcome(config, next);
      if (!config.auth?.username?.startsWith('rzp_test_')) {
        const e = apiError(401, 'Authentication failed');
        return respond(config, e.status, e.body);
      }
      const created = (item: Item): number => item['created_at'] as number;
      if (path === '/v1/payments') return page(config, asItems(collections.payments), 100, created);
      if (path === '/v1/orders') return page(config, asItems(collections.orders), 100, created);
      if (path === '/v1/refunds') return page(config, asItems(collections.refunds), 100, created);
      if (path === '/v1/settlements')
        return page(config, asItems(collections.settlements), 100, created);
      if (path === '/v1/settlements/recon/combined') {
        const text = (value: unknown): string =>
          typeof value === 'string' || typeof value === 'number' ? String(value) : '';
        const year = text(params['year']);
        const month = text(params['month']).padStart(2, '0');
        const day = params['day'] === undefined ? undefined : text(params['day']).padStart(2, '0');
        const prefix = day === undefined ? `${year}-${month}-` : `${year}-${month}-${day}`;
        const settledOn = asItems(collections.recon).filter((item) =>
          istBusinessDate(item['settled_at'] as number).startsWith(prefix),
        );
        return page(config, settledOn, 1000, () => 0);
      }
      const order = /^\/v1\/orders\/(.+)$/.exec(path)?.[1];
      if (order) {
        const found = asItems(collections.orders).find((o) => o['id'] === order);
        return found
          ? respond(config, 200, found)
          : respond(config, 404, apiError(404, 'The id provided does not exist').body);
      }
      return respond(config, 404, apiError(404, `no such endpoint ${path}`).body);
    };
    return Promise.resolve().then(run);
  };

  return {
    adapter,
    calls,
    failNext(prefix, ...outcomes) {
      queued.set(prefix, [...(queued.get(prefix) ?? []), ...outcomes]);
    },
    failWhen(prefix, when, outcome) {
      rules.push({ prefix, when, outcome });
    },
  };
}

// --- synthetic data on disk ------------------------------------------------------------------------

export interface TempDataset {
  readonly dir: string;
  readonly collections: Collections;
  cleanup(): void;
}

const readItems = (dir: string, name: string): unknown[] =>
  (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { items: unknown[] }).items;

export function collectionsFromDir(dir: string): Collections {
  return {
    payments: readItems(dir, 'razorpay_payments.json'),
    orders: readItems(dir, 'razorpay_orders.json'),
    refunds: readItems(dir, 'razorpay_refunds.json'),
    settlements: readItems(dir, 'razorpay_settlements.json'),
    recon: readItems(dir, 'settlement_recon.json'),
  };
}

/** A real datagen dataset in a temp directory. */
export function makeSyntheticDataset(preset: PresetName = 'demo', seed = 42): TempDataset {
  const dir = mkdtempSync(join(tmpdir(), 'ziro-razorpay-'));
  writeDataset(dir, generate(resolveConfig(seed, preset)));
  return {
    dir,
    collections: collectionsFromDir(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Collections written in datagen's file format, so SyntheticSource can read them. */
export function writeCollections(collections: Collections): TempDataset {
  const dir = mkdtempSync(join(tmpdir(), 'ziro-razorpay-docs-'));
  mkdirSync(dir, { recursive: true });
  const write = (name: string, items: unknown[]) =>
    writeFileSync(
      join(dir, name),
      JSON.stringify({ entity: 'collection', count: items.length, items }),
    );
  write('razorpay_payments.json', collections.payments);
  write('razorpay_orders.json', collections.orders);
  write('razorpay_refunds.json', collections.refunds);
  write('razorpay_settlements.json', collections.settlements);
  write('settlement_recon.json', collections.recon);
  return { dir, collections, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- samples from Razorpay's documentation ---------------------------------------------------------

const at = (date: string, hour: number, minute = 0): number =>
  istDayBounds(date).fromEpoch + hour * 3600 + minute * 60;

/**
 * Entities transcribed from the examples on Razorpay's API reference pages (payments, refunds,
 * settlements, recon, orders), with timestamps moved into October 2026 and, where a page showed no
 * id, a placeholder. Deliberately includes what real responses contain and the docs' own samples
 * show: empty `notes` as `[]`, fee/tax null on an uncaptured payment, a captured payment with tax 0,
 * fields the docs list but never sample (amount_captured, provider, token_id), and a recon
 * adjustment line with no credit_type. These are docs-derived, NOT recorded from a live account.
 */
export function docsDerivedCollections(): Collections {
  const base = {
    entity: 'payment',
    currency: 'INR',
    invoice_id: null,
    international: false,
    description: 'Test payment',
    card_id: null,
    bank: null,
    wallet: null,
    vpa: null,
    email: 'gaurav.kumar@example.com',
    contact: '+919000090000',
    notes: [] as unknown,
    error_code: null,
    error_description: null,
    error_source: null,
    error_step: null,
    error_reason: null,
  };

  const payments = [
    {
      ...base,
      id: 'pay_NetBank0000001',
      amount: 2100,
      status: 'captured',
      order_id: 'order_DBJOWzybf0sJbb',
      method: 'netbanking',
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      bank: 'ICIC',
      fee: 50,
      tax: 8,
      acquirer_data: { bank_transaction_id: '0125836177' },
      amount_captured: 2100, // documented, never sampled
      provider: null,
      created_at: at('2026-10-08', 11, 5),
    },
    {
      ...base,
      id: 'pay_UpiPayment0001',
      amount: 1000,
      status: 'captured',
      order_id: 'order_UpiOrder000001',
      method: 'upi',
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      vpa: 'gaurav.kumar@exampleupi',
      fee: 24,
      tax: 4,
      acquirer_data: { rrn: '033814379298' },
      upi: { payer_account_type: 'bank_account', vpa: 'gaurav.kumar@exampleupi', flow: 'collect' },
      created_at: at('2026-10-08', 14, 40),
    },
    {
      ...base,
      id: 'pay_CardNoTax00001',
      amount: 5000,
      status: 'captured',
      order_id: 'order_CardOrder00001',
      method: 'card',
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      card_id: 'card_DG4ZdRK8J0klfa',
      fee: 100,
      tax: 0, // the docs show a fee with tax 0
      acquirer_data: { auth_code: '541898', arn: '10000000000000', rrn: '123456789012' },
      token_id: 'token_Fl9fxbVHx3r1Vh', // documented, appears in one card sample
      created_at: at('2026-10-09', 9, 30),
    },
    {
      ...base,
      id: 'pay_Authorized0001',
      amount: 99900,
      status: 'authorized',
      order_id: null,
      method: 'card',
      amount_refunded: 0,
      refund_status: null,
      captured: false,
      notes: { address: 'Razorpay Corporate Office' },
      fee: null,
      tax: null,
      acquirer_data: {},
      created_at: at('2026-10-09', 16, 0),
    },
    {
      ...base,
      id: 'pay_WalletRefund001',
      amount: 250000,
      status: 'refunded',
      order_id: 'order_WalletOrder001',
      method: 'wallet',
      amount_refunded: 250000,
      refund_status: 'full',
      captured: true,
      wallet: 'freecharge',
      fee: 5900,
      tax: 900,
      acquirer_data: { transaction_id: null },
      created_at: at('2026-10-10', 10, 15),
    },
  ];

  const order = (id: string, receipt: string | null, amount: number, createdAt: number) => ({
    id,
    entity: 'order',
    amount,
    amount_paid: amount,
    amount_due: 0,
    currency: 'INR',
    receipt,
    offer_id: null,
    status: 'paid',
    attempts: 1,
    notes: [] as unknown,
    created_at: createdAt,
  });

  const orders = [
    order('order_DBJOWzybf0sJbb', 'ORD-5001', 2100, at('2026-10-08', 11, 0)),
    order('order_UpiOrder000001', 'ORD-5002', 1000, at('2026-10-08', 14, 35)),
    order('order_CardOrder00001', 'ORD-5003', 5000, at('2026-10-09', 9, 25)),
    order('order_WalletOrder001', 'ORD-5004', 250000, at('2026-10-10', 10, 10)),
  ];

  const refunds = [
    {
      id: 'rfnd_DfjjhJC6eDvUAi',
      entity: 'refund',
      amount: 6000,
      currency: 'INR',
      payment_id: 'pay_NetBank0000001',
      notes: { comment: 'Issuing an instant refund' },
      receipt: null,
      acquirer_data: { arn: '10000000000000' },
      created_at: at('2026-10-12', 12, 0),
      batch_id: null,
      status: 'processed',
      speed_processed: 'optimum',
      speed_requested: 'optimum',
    },
  ];

  const settlements = [
    {
      id: 'setl_DGlQ1Rj8os78Ec',
      entity: 'settlement',
      amount: 9973635,
      status: 'processed',
      fees: 0,
      tax: 0,
      utr: '1568176960vxp0rj',
      created_at: at('2026-10-12', 7, 30),
    },
  ];

  const line = (extra: Record<string, unknown>) => ({
    currency: 'INR',
    on_hold: false,
    settled: true,
    created_at: at('2026-10-09', 12, 0),
    settled_at: at('2026-10-12', 7, 30),
    settlement_id: 'setl_DGlQ1Rj8os78Ec',
    posted_at: null,
    settlement_utr: '1568176960vxp0rj',
    order_id: null,
    order_receipt: null,
    method: null,
    card_network: null,
    card_issuer: null,
    card_type: null,
    dispute_id: null,
    description: null,
    notes: [] as unknown,
    payment_id: null,
    ...extra,
  });

  const recon = [
    line({
      entity_id: 'pay_DEXrnipqTmWVGE',
      type: 'payment',
      debit: 0,
      credit: 97100,
      amount: 100000,
      fee: 2900,
      tax: 0,
      credit_type: 'default',
      method: 'card',
      description: 'Recurring Payment via Subscription',
    }),
    line({
      entity_id: 'rfnd_DGRcGzZSLyEdg1',
      type: 'refund',
      debit: 242500,
      credit: 0,
      amount: 242500,
      fee: 0,
      tax: 0,
      credit_type: 'default',
      method: 'card',
      payment_id: 'pay_EpkFDYRirena0f',
    }),
    line({
      entity_id: 'trf_DEUoCEtdsJgvl7',
      type: 'transfer',
      debit: 100296,
      credit: 0,
      amount: 100000,
      fee: 296,
      tax: 46,
      credit_type: 'default',
      payment_id: 'pay_EpkFDYRirena0f',
      notes: null,
    }),
    line({
      entity_id: 'adj_EhcHONhX4ChgNC',
      type: 'adjustment',
      debit: 0,
      credit: 1012,
      amount: 1012,
      fee: 0,
      tax: 0,
      description: 'test reason',
    }),
  ];

  return { payments, orders, refunds, settlements, recon };
}
