// The contract: whatever sits behind RazorpaySource, a caller gets the same domain records.
// The SAME raw Razorpay data is served two ways: read from files (SyntheticSource) and fetched
// through the real official SDK from an emulated Razorpay API (TestModeSource). For every entity
// the two must agree exactly, record for record, differing only in the honest `source` label.
import {
  rzpPaymentSchema,
  rzpRefundSchema,
  rzpSettlementSchema,
  settlementItemSchema,
} from '@ziro/core/domain';
import { addDaysToBusinessDate } from '@ziro/core/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Collections,
  createEmulator,
  docsDerivedCollections,
  makeSyntheticDataset,
  RUN_ID,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
  type TempDataset,
  writeCollections,
} from './razorpay.fixtures.js';
import { createSdkClient } from './sdk-client.js';
import type { DateRange, FetchResult, RazorpaySource } from './source.js';
import { SyntheticSource } from './synthetic.source.js';
import { TestModeSource } from './testmode.source.js';

interface Scenario {
  name: string;
  data: TempDataset;
  range: DateRange;
  dates: string[];
}

const days = (from: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDaysToBusinessDate(from, i));

const scenarios: Scenario[] = [];
beforeAll(() => {
  const demo = makeSyntheticDataset('demo', 42);
  const evalSet = makeSyntheticDataset('eval', 42);
  const docs = writeCollections(docsDerivedCollections());
  scenarios.push(
    {
      name: 'datagen demo (50 orders)',
      data: demo,
      range: { from: '2026-09-01', to: '2026-10-15' },
      dates: days('2026-09-01', 45),
    },
    {
      name: 'datagen eval (500 orders)',
      data: evalSet,
      range: { from: '2026-04-01', to: '2026-05-30' },
      dates: days('2026-04-01', 60),
    },
    {
      name: 'docs-derived samples',
      data: docs,
      range: { from: '2026-10-01', to: '2026-10-31' },
      dates: days('2026-10-01', 31),
    },
  );
});
afterAll(() => scenarios.forEach((s) => s.data.cleanup()));

/** A fallback that must never be needed: both adapters are given the full data. */
const tripwire: RazorpaySource = {
  fetchPayments: () => Promise.reject(new Error('fallback used for payments')),
  fetchRefunds: () => Promise.reject(new Error('fallback used for refunds')),
  fetchSettlements: () => Promise.reject(new Error('fallback used for settlements')),
  fetchSettlementRecon: () => Promise.reject(new Error('fallback used for recon')),
};

function adapters(collections: Collections, dir: string) {
  const synthetic = new SyntheticSource({ runId: RUN_ID, dir });
  const client = createSdkClient({
    keyId: TEST_KEY_ID,
    keySecret: TEST_KEY_SECRET,
    adapter: createEmulator(collections).adapter,
    deps: { sleep: () => Promise.resolve(), random: () => 0 },
  });
  const testmode = new TestModeSource({ runId: RUN_ID, client, fallback: tripwire });
  return { synthetic, testmode };
}

/** Everything but the label: what must be identical across adapters. */
const content = <T extends { source: string }>(result: FetchResult<T>) =>
  result.items.map(({ record, raw }) => ({ record: { ...record, source: '(label)' }, raw }));

const fieldTypes = (record: object): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, value === null ? 'null' : typeof value]),
  );

describe.each([0, 1, 2])('RazorpaySource contract, scenario %i', (index) => {
  const scenario = (): Scenario => scenarios[index] as Scenario;
  const both = () => adapters(scenario().data.collections, scenario().data.dir);

  it('payments: identical domain records and originals, labelled by where they came from', async () => {
    const { synthetic, testmode } = both();
    const [s, t] = [
      await synthetic.fetchPayments(scenario().range),
      await testmode.fetchPayments(scenario().range),
    ];
    expect(s.items.length).toBe(scenario().data.collections.payments.length);
    expect(content(t)).toEqual(content(s));
    expect(s.source).toBe('synthetic');
    expect(t.source).toBe('razorpay_testmode');
    expect(s.items.every((i) => i.record.source === 'synthetic')).toBe(true);
    expect(t.items.every((i) => i.record.source === 'razorpay_testmode')).toBe(true);
    expect([s.provenance.reason, t.provenance.reason]).toEqual(['ok', 'ok']);
  });

  it('refunds: identical', async () => {
    const { synthetic, testmode } = both();
    const [s, t] = [
      await synthetic.fetchRefunds(scenario().range),
      await testmode.fetchRefunds(scenario().range),
    ];
    expect(s.items.length).toBe(scenario().data.collections.refunds.length);
    expect(content(t)).toEqual(content(s));
  });

  it('settlements: identical', async () => {
    const { synthetic, testmode } = both();
    const [s, t] = [
      await synthetic.fetchSettlements(scenario().range),
      await testmode.fetchSettlements(scenario().range),
    ];
    expect(s.items.length).toBe(scenario().data.collections.settlements.length);
    expect(content(t)).toEqual(content(s));
  });

  it('settlement recon, day by day: identical, and together exactly the whole report', async () => {
    const { synthetic, testmode } = both();
    const sAll: ReturnType<typeof content<(typeof settlementItemSchema)['_output']>> = [];
    const tAll: typeof sAll = [];
    for (const date of scenario().dates) {
      const [s, t] = [
        await synthetic.fetchSettlementRecon(date),
        await testmode.fetchSettlementRecon(date),
      ];
      expect(content(t), date).toEqual(content(s));
      sAll.push(...content(s));
      tAll.push(...content(t));
    }
    expect(sAll).toHaveLength(scenario().data.collections.recon.length);
    expect(tAll).toEqual(sAll);
  });

  it('every record is a valid domain record with the same field names and types from both adapters', async () => {
    const { synthetic, testmode } = both();
    const { range, dates } = scenario();
    const pairs = [
      [await synthetic.fetchPayments(range), await testmode.fetchPayments(range), rzpPaymentSchema],
      [await synthetic.fetchRefunds(range), await testmode.fetchRefunds(range), rzpRefundSchema],
      [
        await synthetic.fetchSettlements(range),
        await testmode.fetchSettlements(range),
        rzpSettlementSchema,
      ],
      [
        await synthetic.fetchSettlementRecon(dates[0] as string),
        await testmode.fetchSettlementRecon(dates[0] as string),
        settlementItemSchema,
      ],
    ] as const;
    for (const [s, t, schema] of pairs) {
      for (const { record } of [...s.items, ...t.items])
        expect(schema.safeParse(record).success).toBe(true);
      const sFirst = s.items[0]?.record;
      const tFirst = t.items[0]?.record;
      if (sFirst && tFirst) {
        expect(Object.keys(tFirst)).toEqual(Object.keys(sFirst));
        expect(fieldTypes(tFirst)).toEqual(fieldTypes(sFirst));
      }
    }
  });

  it('money is bigint paise and dates are IST business dates on every record', async () => {
    const { testmode } = both();
    const { items } = await testmode.fetchPayments(scenario().range);
    for (const { record } of items) {
      for (const field of [record.amount, record.fee, record.tax, record.amountRefunded])
        expect(typeof field).toBe('bigint');
      expect(record.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });
});

describe('the contract is real: it fails if an adapter drifts', () => {
  it('detects a test-mode adapter that returns a different amount', async () => {
    const scenario = scenarios[0] as Scenario;
    const tampered: Collections = {
      ...scenario.data.collections,
      payments: scenario.data.collections.payments.map((p, i) =>
        i === 0 ? { ...(p as object), amount: 1 } : p,
      ),
    };
    const { synthetic } = adapters(scenario.data.collections, scenario.data.dir);
    const { testmode } = adapters(tampered, scenario.data.dir);
    const [s, t] = [
      await synthetic.fetchPayments(scenario.range),
      await testmode.fetchPayments(scenario.range),
    ];
    expect(content(t)).not.toEqual(content(s));
  });
});
