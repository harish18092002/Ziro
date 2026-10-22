import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rzpPaymentSchema,
  rzpRefundSchema,
  rzpSettlementSchema,
  settlementItemSchema,
} from '@ziro/core/domain';
import { addDaysToBusinessDate, istBusinessDate } from '@ziro/core/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RazorpayConfigError, RazorpayResponseError } from './errors.js';
import { makeSyntheticDataset, RUN_ID, type TempDataset } from './razorpay.fixtures.js';
import { SyntheticSource } from './synthetic.source.js';

// The demo preset: statement window 2026-09-01 for 45 days.
const FULL = { from: '2026-09-01', to: '2026-10-15' };
const DAYS = Array.from({ length: 45 }, (_, i) => addDaysToBusinessDate('2026-09-01', i));

let data: TempDataset;
let source: SyntheticSource;
beforeAll(() => {
  data = makeSyntheticDataset('demo', 42);
  source = new SyntheticSource({ runId: RUN_ID, dir: data.dir });
});
afterAll(() => data.cleanup());

const truth = () =>
  JSON.parse(readFileSync(join(data.dir, 'truth.json'), 'utf8')) as {
    anomalies: { reasonCode: string; detail: Record<string, string> }[];
  };

describe('SyntheticSource', () => {
  it('returns every payment as a valid domain record labelled synthetic', async () => {
    const result = await source.fetchPayments(FULL);
    expect(result.items).toHaveLength(data.collections.payments.length);
    expect(result.source).toBe('synthetic');
    expect(result.provenance).toEqual({
      entity: 'payments',
      source: 'synthetic',
      reason: 'ok',
      requests: 0,
      warnings: [],
    });
    for (const { record } of result.items) {
      expect(rzpPaymentSchema.safeParse(record).success).toBe(true);
      expect(record.source).toBe('synthetic');
      expect(typeof record.amount).toBe('bigint');
    }
  });

  it('gives failed attempts a fee of 0 (nothing was charged) and keeps them out of the money', async () => {
    const { items } = await source.fetchPayments(FULL);
    const failed = items.filter((i) => i.record.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const { record } of failed)
      expect(record).toMatchObject({ fee: 0n, tax: 0n, captured: false });
    for (const { record } of items.filter((i) => i.record.captured))
      expect(record.fee).toBeGreaterThan(0n);
  });

  it("joins each payment to its order's receipt, which is the ledger's order_ref", async () => {
    const ledgerRefs = new Set(
      readFileSync(join(data.dir, 'ledger.csv'), 'utf8')
        .split('\n')
        .slice(1)
        .map((line) => line.split(',')[0])
        .filter(Boolean),
    );
    const { items } = await source.fetchPayments(FULL);
    const captured = items.filter((i) => i.record.captured);
    const links = captured.filter((i) => i.record.receipt === null);
    // Payment-link payments have no receipt; everything else carries one.
    expect(links).toHaveLength(
      truth().anomalies.filter((a) => a.reasonCode === 'PAYMENT_WITHOUT_LEDGER').length,
    );
    for (const { record } of captured) {
      if (record.receipt === null) continue;
      const original = record.receipt.replace(/-R1$/, ''); // a checkout retry's receipt has a suffix
      expect(ledgerRefs.has(original), `${record.paymentId} -> ${record.receipt}`).toBe(true);
    }
  });

  it('puts a timezone-shifted payment on the day after its ledger row', async () => {
    const { items } = await source.fetchPayments(FULL);
    const byId = new Map(items.map((i) => [i.record.paymentId, i.record]));
    const ledgerDates = new Map(
      readFileSync(join(data.dir, 'ledger.csv'), 'utf8')
        .split('\n')
        .slice(1)
        .filter(Boolean)
        .map((l) => {
          const [ref, date] = l.split(',') as [string, string];
          const [d, m, y] = date.split('-');
          return [ref, `${y}-${m}-${d}`] as const;
        }),
    );
    const shifted = truth().anomalies.filter((a) => a.reasonCode === 'TIMEZONE_DATE_SHIFT');
    expect(shifted.length).toBeGreaterThan(0);
    for (const a of shifted) {
      const ref = a.detail['orderRef'] as string;
      const payment = items.map((i) => i.record).find((p) => p.receipt === ref && p.captured);
      expect(payment?.businessDate, ref).toBe(a.detail['paymentBusinessDate']);
      expect(payment?.businessDate, ref).not.toBe(ledgerDates.get(ref));
    }
    expect(byId.size).toBeGreaterThan(0);
  });

  it('filters by IST business date: consecutive days partition the full range exactly', async () => {
    const whole = await source.fetchPayments(FULL);
    const perDay = await Promise.all(
      DAYS.map((day) => source.fetchPayments({ from: day, to: day })),
    );
    expect(perDay.flatMap((r) => r.items.map((i) => i.record.paymentId)).sort()).toEqual(
      whole.items.map((i) => i.record.paymentId).sort(),
    );
    perDay.forEach((result, i) => {
      for (const { record } of result.items) expect(record.businessDate).toBe(DAYS[i]);
    });
  });

  it('maps refunds and settlements, and the whole settlement still equals its lines to the paise', async () => {
    const refunds = await source.fetchRefunds(FULL);
    expect(refunds.items).toHaveLength(data.collections.refunds.length);
    for (const { record } of refunds.items)
      expect(rzpRefundSchema.safeParse(record).success).toBe(true);

    const settlements = await source.fetchSettlements(FULL);
    expect(settlements.items).toHaveLength(data.collections.settlements.length);
    for (const { record } of settlements.items)
      expect(rzpSettlementSchema.safeParse(record).success).toBe(true);

    const lines = (await Promise.all(DAYS.map((d) => source.fetchSettlementRecon(d)))).flatMap(
      (r) => r.items.map((i) => i.record),
    );
    expect(lines).toHaveLength(data.collections.recon.length);
    for (const line of lines) expect(settlementItemSchema.safeParse(line).success).toBe(true);
    for (const { record: s } of settlements.items) {
      const own = lines.filter((l) => l.settlementId === s.settlementId);
      const net = own.reduce((sum, l) => sum + l.credit - l.debit, 0n);
      expect(net, s.settlementId).toBe(s.amount);
    }
  });

  it('returns each recon line only on the IST day it was settled', async () => {
    let checked = 0;
    for (const day of DAYS) {
      const { items } = await source.fetchSettlementRecon(day);
      for (const { record } of items) {
        // settledAt is a UTC instant; its IST date must be exactly the day that was asked for.
        expect(istBusinessDate(Date.parse(record.settledAt ?? '') / 1000), record.sourceRef).toBe(
          day,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(data.collections.recon.length);
  });

  it('is deterministic, and re-running with another run id changes ids but not content hashes', async () => {
    const again = new SyntheticSource({ runId: RUN_ID, dir: data.dir });
    expect(await again.fetchPayments(FULL)).toEqual(await source.fetchPayments(FULL));

    const other = new SyntheticSource({
      runId: '00000000-0000-4000-8000-0000000000bb',
      dir: data.dir,
    });
    const [a, b] = [await source.fetchPayments(FULL), await other.fetchPayments(FULL)];
    expect(b.items[0]?.record.id).not.toBe(a.items[0]?.record.id);
    expect(b.items.map((i) => i.record.importHash)).toEqual(
      a.items.map((i) => i.record.importHash),
    );
  });

  it('keeps the original payload as received next to each record', async () => {
    const { items } = await source.fetchPayments(FULL);
    const first = items[0];
    expect((first?.raw as { id: string }).id).toBe(first?.record.paymentId);
    expect(first?.raw).toEqual(
      data.collections.payments.find((p) => (p as { id: string }).id === first?.record.paymentId),
    );
  });
});

describe('SyntheticSource errors', () => {
  it('says how to generate data when the directory has none', async () => {
    const missing = new SyntheticSource({ runId: RUN_ID, dir: join(data.dir, 'does-not-exist') });
    const error = await missing.fetchPayments(FULL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayConfigError);
    expect((error as Error).message).toMatch(/npm run datagen/);
  });

  it('rejects a file that is not valid JSON, or not a collection', async () => {
    writeFileSync(join(data.dir, 'razorpay_refunds.json'), '{not json');
    const broken = new SyntheticSource({ runId: RUN_ID, dir: data.dir });
    await expect(broken.fetchRefunds(FULL)).rejects.toBeInstanceOf(RazorpayResponseError);

    writeFileSync(join(data.dir, 'razorpay_refunds.json'), JSON.stringify({ hello: 'world' }));
    const wrongShape = new SyntheticSource({ runId: RUN_ID, dir: data.dir });
    await expect(wrongShape.fetchRefunds(FULL)).rejects.toThrow(/not a collection/);
  });

  it('rejects a record that is missing a field we depend on, naming the field but not the value', async () => {
    writeFileSync(
      join(data.dir, 'razorpay_settlements.json'),
      JSON.stringify({
        entity: 'collection',
        count: 1,
        items: [
          { id: 'setl_Abc123', status: 'processed', secretish: 'do-not-echo', created_at: 1 },
        ],
      }),
    );
    const bad = new SyntheticSource({ runId: RUN_ID, dir: data.dir });
    const error = await bad
      .fetchSettlements({ from: '1970-01-02', to: '1970-01-03' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayResponseError);
    expect((error as Error).message).toMatch(/amount/);
    expect((error as Error).message).not.toContain('do-not-echo');
  });

  it('rejects a range that ends before it starts', async () => {
    await expect(
      source.fetchPayments({ from: '2026-10-02', to: '2026-10-01' }),
    ).rejects.toBeInstanceOf(RazorpayConfigError);
  });
});
