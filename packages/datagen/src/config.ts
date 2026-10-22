import { parseIsoDay } from './time.js';

export type Method = 'card' | 'upi' | 'netbanking';

export const PRESET_NAMES = ['demo', 'eval', 'stress'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/**
 * Anomaly rates in basis points. The first nine are per ORDER (a share of `orders`); the last two
 * are per SETTLEMENT / bank credit. Counts are exact, not random: see `countFor`.
 */
export interface Rates {
  readonly DUPLICATE_PAYMENT: number;
  readonly LEDGER_WITHOUT_PAYMENT: number;
  readonly PAYMENT_WITHOUT_LEDGER: number;
  readonly PARTIAL_REFUND_NETTED: number;
  readonly FULL_REFUND: number;
  readonly CHARGEBACK_ADJUSTMENT: number;
  readonly LEDGER_AMOUNT_EDITED: number;
  readonly TIMEZONE_DATE_SHIFT: number;
  readonly FEE_OVERCHARGE: number;
  readonly SETTLEMENT_DELAYED: number;
  readonly UTR_MISSING_OR_GARBLED: number;
}

export type RateKey = keyof Rates;

/** Rates that take their share from the pool of orders and are mutually exclusive. */
export const ORDER_POOL_CODES = [
  'CHARGEBACK_ADJUSTMENT',
  'FULL_REFUND',
  'PARTIAL_REFUND_NETTED',
  'DUPLICATE_PAYMENT',
  'LEDGER_WITHOUT_PAYMENT',
  'LEDGER_AMOUNT_EDITED',
  'FEE_OVERCHARGE',
  'TIMEZONE_DATE_SHIFT',
] as const satisfies readonly RateKey[];

export interface BankConfig {
  /** Opening balance in paise. */
  readonly openingBalancePaise: bigint;
  /** Non-Razorpay lines (customer transfers, vendor payments, charges) added to the statement. */
  readonly noiseLines: number;
  /** Same-amount decoy credits, as bps of settlement credits. They create real ambiguity. */
  readonly decoyBps: number;
  /** Share of settlement credits that land one day after the settlement date. */
  readonly lagOneDayBps: number;
  /**
   * Total non-Razorpay debits as bps of total credits: a business spends a fraction of what it
   * takes in. Without it, tens of thousands of debits would drain the account.
   */
  readonly debitShareBps: number;
}

export interface GenConfig {
  readonly preset: PresetName | 'custom';
  readonly seed: number;
  /** Ledger rows ("orders"), including cash-on-delivery rows that never touch Razorpay. */
  readonly orders: number;
  /** First day of the bank statement window, `YYYY-MM-DD` (IST). */
  readonly startDate: string;
  /** Length of the statement window in days. */
  readonly days: number;
  /** Trailing days with no new orders, so every payment settles inside the window. */
  readonly tailDays: number;
  /** Bank holidays that repeat every year, `MM-DD`. Weekends are always non-business days. */
  readonly fixedHolidays: readonly string[];
  readonly methodWeights: Readonly<Record<Method, number>>;
  /** Contracted Razorpay fee rate per method, in bps of the payment amount (before GST). */
  readonly feeBps: Readonly<Record<Method, number>>;
  /** GST on the fee, in bps. 1800 = 18%. */
  readonly gstBps: number;
  /** Settlements arrive this many business days after capture (T+2). */
  readonly settlementLagBusinessDays: number;
  readonly rates: Rates;
  /** FEE_OVERCHARGE adds a uniform amount in this inclusive bps range to the contracted rate. */
  readonly overchargeExtraBps: readonly [number, number];
  /** Failed (zero-money) payment attempts, as bps of orders. Noise a matcher must ignore. */
  readonly failedAttemptBps: number;
  /** Refunds and chargebacks are only generated for payments at or under this many paise. */
  readonly debitCapPaise: bigint;
  readonly bank: BankConfig;
  /** Adversarial memos/narrations/notes to inject, labelled in truth.json. */
  readonly injections: number;
  /** JSON indentation: 2 = pretty, 0 = one compact line per item (used for stress). */
  readonly jsonIndent: 0 | 2;
}

const COMMON = {
  fixedHolidays: ['01-26', '04-14', '05-01', '08-15', '10-02', '12-25'],
  methodWeights: { card: 45, upi: 40, netbanking: 15 },
  feeBps: { card: 200, upi: 100, netbanking: 190 },
  gstBps: 1800,
  settlementLagBusinessDays: 2,
  overchargeExtraBps: [50, 150],
  debitCapPaise: 500_000n,
} as const;

const EVAL_RATES: Rates = {
  DUPLICATE_PAYMENT: 200,
  LEDGER_WITHOUT_PAYMENT: 300,
  PAYMENT_WITHOUT_LEDGER: 200,
  PARTIAL_REFUND_NETTED: 400,
  FULL_REFUND: 300,
  CHARGEBACK_ADJUSTMENT: 100,
  LEDGER_AMOUNT_EDITED: 200,
  TIMEZONE_DATE_SHIFT: 300,
  FEE_OVERCHARGE: 300,
  SETTLEMENT_DELAYED: 800,
  UTR_MISSING_OR_GARBLED: 2000,
};

export const PRESETS: Readonly<Record<PresetName, Omit<GenConfig, 'seed'>>> = {
  // Boosted rates so every anomaly appears at least once in a small, clickable dataset.
  demo: {
    ...COMMON,
    preset: 'demo',
    orders: 50,
    startDate: '2026-09-01',
    days: 45,
    tailDays: 12,
    rates: {
      DUPLICATE_PAYMENT: 400,
      LEDGER_WITHOUT_PAYMENT: 600,
      PAYMENT_WITHOUT_LEDGER: 400,
      PARTIAL_REFUND_NETTED: 600,
      FULL_REFUND: 400,
      CHARGEBACK_ADJUSTMENT: 200,
      LEDGER_AMOUNT_EDITED: 400,
      TIMEZONE_DATE_SHIFT: 400,
      FEE_OVERCHARGE: 400,
      SETTLEMENT_DELAYED: 1500,
      UTR_MISSING_OR_GARBLED: 3000,
    },
    failedAttemptBps: 600,
    bank: {
      openingBalancePaise: 20_000_000n,
      noiseLines: 20,
      decoyBps: 1000,
      lagOneDayBps: 2000,
      debitShareBps: 6500,
    },
    injections: 3,
    jsonIndent: 2,
  },
  // The published-metrics dataset: enough of each anomaly (>= 5) to measure something.
  eval: {
    ...COMMON,
    preset: 'eval',
    orders: 500,
    startDate: '2026-04-01',
    days: 60,
    tailDays: 12,
    rates: EVAL_RATES,
    failedAttemptBps: 500,
    bank: {
      openingBalancePaise: 100_000_000n,
      noiseLines: 150,
      decoyBps: 500,
      lagOneDayBps: 2000,
      debitShareBps: 6500,
    },
    injections: 8,
    jsonIndent: 2,
  },
  // Scale test for the matcher: order-level rates are a quarter of eval's, and most of the ~100k
  // bank lines are non-Razorpay noise, so same-amount candidate search is genuinely hard.
  stress: {
    ...COMMON,
    preset: 'stress',
    orders: 100_000,
    startDate: '2024-04-01',
    days: 730,
    tailDays: 12,
    rates: {
      DUPLICATE_PAYMENT: 50,
      LEDGER_WITHOUT_PAYMENT: 75,
      PAYMENT_WITHOUT_LEDGER: 50,
      PARTIAL_REFUND_NETTED: 100,
      FULL_REFUND: 75,
      CHARGEBACK_ADJUSTMENT: 25,
      LEDGER_AMOUNT_EDITED: 50,
      TIMEZONE_DATE_SHIFT: 75,
      FEE_OVERCHARGE: 75,
      SETTLEMENT_DELAYED: 800,
      UTR_MISSING_OR_GARBLED: 2000,
    },
    failedAttemptBps: 500,
    bank: {
      openingBalancePaise: 5_000_000_000n,
      noiseLines: 99_000,
      decoyBps: 500,
      lagOneDayBps: 2000,
      debitShareBps: 6500,
    },
    injections: 100,
    jsonIndent: 0,
  },
};

export interface ConfigOverrides {
  readonly orders?: number;
  readonly startDate?: string;
  readonly days?: number;
  readonly tailDays?: number;
  readonly rates?: Partial<Rates>;
  readonly bank?: Partial<BankConfig>;
  readonly failedAttemptBps?: number;
  readonly injections?: number;
  readonly jsonIndent?: 0 | 2;
}

/** `seed` plus a preset, with optional overrides, validated. */
export function resolveConfig(
  seed: number,
  preset: PresetName,
  overrides: ConfigOverrides = {},
): GenConfig {
  const base = PRESETS[preset];
  const config: GenConfig = {
    ...base,
    seed,
    orders: overrides.orders ?? base.orders,
    startDate: overrides.startDate ?? base.startDate,
    days: overrides.days ?? base.days,
    tailDays: overrides.tailDays ?? base.tailDays,
    rates: { ...base.rates, ...overrides.rates },
    bank: { ...base.bank, ...overrides.bank },
    failedAttemptBps: overrides.failedAttemptBps ?? base.failedAttemptBps,
    injections: overrides.injections ?? base.injections,
    jsonIndent: overrides.jsonIndent ?? base.jsonIndent,
  };
  validateConfig(config);
  return config;
}

/**
 * Exact number of items an anomaly rate selects from a pool: `bps * pool / 10 000`, rounded
 * half-up, in pure integer arithmetic. Deterministic, and never off by more than 1/2.
 */
export function countFor(bps: number, pool: number): number {
  const scaled = bps * pool + 5000;
  return (scaled - (scaled % 10_000)) / 10_000;
}

export function validateConfig(config: GenConfig): void {
  const fail = (message: string): never => {
    throw new RangeError(`invalid datagen config: ${message}`);
  };
  const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
  const isBps = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= 10_000;

  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) {
    fail('seed must be an unsigned 32-bit integer');
  }
  if (!isCount(config.orders) || config.orders < 1) fail('orders must be a positive integer');
  parseIsoDay(config.startDate);
  if (!isCount(config.days) || !isCount(config.tailDays))
    fail('days and tailDays must be integers');
  if (config.days <= config.tailDays + 1) fail('days must exceed tailDays by at least 2');
  for (const [key, value] of Object.entries(config.rates) as [string, number][]) {
    if (!isBps(value)) fail(`rate ${key} must be an integer between 0 and 10000 bps`);
  }
  for (const method of ['card', 'upi', 'netbanking'] as const) {
    if (!isBps(config.feeBps[method])) fail(`feeBps.${method} must be 0..10000`);
    if (!isCount(config.methodWeights[method])) fail(`methodWeights.${method} must be an integer`);
  }
  if (config.methodWeights.card + config.methodWeights.upi + config.methodWeights.netbanking < 1) {
    fail('at least one payment method needs a positive weight');
  }
  if (!isBps(config.gstBps) || !isBps(config.failedAttemptBps)) fail('bps values must be 0..10000');
  if (
    !isBps(config.bank.decoyBps) ||
    !isBps(config.bank.lagOneDayBps) ||
    !isBps(config.bank.debitShareBps)
  )
    fail('bank bps must be 0..10000');
  if (!isCount(config.bank.noiseLines) || !isCount(config.injections)) {
    fail('noiseLines and injections must be non-negative integers');
  }
  const [lo, hi] = config.overchargeExtraBps;
  if (!isBps(lo) || !isBps(hi) || hi < lo || lo < 1)
    fail('overchargeExtraBps must be an ascending range >= 1');
  if (config.settlementLagBusinessDays < 0 || !Number.isInteger(config.settlementLagBusinessDays)) {
    fail('settlementLagBusinessDays must be a non-negative integer');
  }
  for (const holiday of config.fixedHolidays) {
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(holiday)) fail(`bad holiday ${holiday}`);
  }

  const pool = ORDER_POOL_CODES.reduce(
    (sum, code) => sum + countFor(config.rates[code], config.orders),
    0,
  );
  if (pool > config.orders) {
    fail(`order-level anomalies need ${pool} orders but only ${config.orders} exist`);
  }
}
