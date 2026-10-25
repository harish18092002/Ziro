import { describe, expect, it } from 'vitest';
import { itemOf, settlementOn, stubSource } from './ingest.fixtures.js';
import {
  fetchBundle,
  ImportRangeError,
  MAX_RECON_DAYS,
  SETTLEMENT_LOOKAHEAD_DAYS,
  windowFor,
} from './razorpay-bundle.js';

describe('windowFor', () => {
  it('looks for settlements a week past the end of the window', () => {
    expect(SETTLEMENT_LOOKAHEAD_DAYS).toBe(7);
    expect(windowFor('2026-09-01', '2026-09-10')).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
      settlementsThrough: '2026-09-17',
    });
    expect(windowFor('2026-12-28', '2026-12-30').settlementsThrough).toBe('2027-01-06');
  });
});

describe('fetchBundle', () => {
  const window = windowFor('2026-09-01', '2026-09-10');

  it('asks for payments and refunds in the window and settlements through the look-ahead', async () => {
    const { source, calls } = stubSource();
    await fetchBundle(source, window);
    expect(calls.payments).toEqual([{ from: '2026-09-01', to: '2026-09-10' }]);
    expect(calls.refunds).toEqual([{ from: '2026-09-01', to: '2026-09-10' }]);
    expect(calls.settlements).toEqual([{ from: '2026-09-01', to: '2026-09-17' }]);
  });

  it('asks for no recon report when there are no settlements', async () => {
    const { source, calls } = stubSource();
    const bundle = await fetchBundle(source, window);
    expect(calls.recon).toEqual([]);
    expect(bundle.items).toEqual([]);
  });

  it('asks for the recon report of every day from the first to the last settlement', async () => {
    const { source, calls } = stubSource({
      settlements: [settlementOn('setl_2', '2026-09-05'), settlementOn('setl_1', '2026-09-02')],
    });
    await fetchBundle(source, window);
    expect(calls.recon).toEqual(['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('collects the items of every day, once each', async () => {
    const day2 = itemOf(1, 'setl_1', '2026-09-02');
    const day4 = itemOf(2, 'setl_1', '2026-09-04');
    const { source } = stubSource({
      settlements: [settlementOn('setl_1', '2026-09-02'), settlementOn('setl_2', '2026-09-04')],
      items: [day2, day4, { ...day2 }],
    });
    const bundle = await fetchBundle(source, window);
    expect(bundle.items.map((i) => i.record.sourceRef)).toEqual(['recon-1', 'recon-2']);
  });

  it('refuses a settlement span that would need an unreasonable number of recon calls', async () => {
    const { source, calls } = stubSource({
      settlements: [settlementOn('setl_1', '2024-01-01'), settlementOn('setl_2', '2026-09-05')],
    });
    await expect(fetchBundle(source, window)).rejects.toThrow(ImportRangeError);
    await expect(fetchBundle(source, window)).rejects.toThrow(String(MAX_RECON_DAYS));
    expect(calls.recon.length).toBeLessThanOrEqual(MAX_RECON_DAYS + 1);
  });

  it('reports one provenance entry per entity, in a fixed order', async () => {
    const { source } = stubSource({
      settlements: [settlementOn('setl_1', '2026-09-02')],
      labels: { payments: 'razorpay_testmode' },
    });
    const bundle = await fetchBundle(source, window);
    expect(bundle.provenance.map((p) => [p.entity, p.source])).toEqual([
      ['payments', 'razorpay_testmode'],
      ['refunds', 'synthetic'],
      ['settlements', 'synthetic'],
      ['settlement_recon', 'synthetic'],
    ]);
  });

  it('labels recon like its settlements: the same source answered both', async () => {
    const settlements = [
      settlementOn('setl_1', '2026-09-02'),
      settlementOn('setl_2', '2026-09-03'),
    ];
    const real = await fetchBundle(
      stubSource({
        settlements,
        labels: { settlements: 'razorpay_testmode' },
        reconLabelFor: () => 'razorpay_testmode',
      }).source,
      window,
    );
    expect(real.provenance[3]).toMatchObject({
      source: 'razorpay_testmode',
      requests: 6,
      warnings: [],
    });

    const generated = await fetchBundle(stubSource({ settlements }).source, window);
    expect(generated.provenance[3]).toMatchObject({ source: 'synthetic', requests: 0 });
  });

  it('still labels recon test-mode when there were no settlements and so no recon day to ask for', async () => {
    const { source, calls } = stubSource({ labels: { settlements: 'razorpay_testmode' } });
    const bundle = await fetchBundle(source, window);
    expect(calls.recon).toHaveLength(0);
    expect(bundle.provenance[3]).toMatchObject({
      entity: 'settlement_recon',
      source: 'razorpay_testmode',
    });
  });

  it('carries each entity`s own warnings through, once', async () => {
    const { source } = stubSource({
      settlements: [settlementOn('setl_1', '2026-09-02'), settlementOn('setl_2', '2026-09-03')],
      warnings: { settlement_recon: ['one order could not be found'] },
    });
    const bundle = await fetchBundle(source, window);
    expect(bundle.provenance[3]?.warnings).toEqual(['one order could not be found']);
  });
});
