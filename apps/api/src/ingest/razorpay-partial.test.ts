// What the importer does when Razorpay fails for PART of what it was asked: it keeps what arrived,
// lists what did not, and never pretends the rest was empty. Every failure here is one that survived
// the source's own retries (the error says 5 tries).
import { describe, expect, it } from 'vitest';
import {
  RazorpayApiError,
  RazorpayConfigError,
  RazorpayResponseError,
} from '../razorpay/errors.js';
import type { Incomplete, RazorpaySource } from '../razorpay/source.js';
import { itemOf, settlementOn, stubSource, withFailures } from './ingest.fixtures.js';
import { fetchBundle, nothingFetched, RECON_FAILURE_STREAK, windowFor } from './razorpay-bundle.js';

const window = windowFor('2026-09-01', '2026-09-10');
const down = (status = 503) =>
  new RazorpayApiError(status, 'SERVER_ERROR', 'upstream is unavailable', null, 5);

const twoSettlements = () =>
  stubSource({
    settlements: [settlementOn('setl_1', '2026-09-02'), settlementOn('setl_2', '2026-09-04')],
    items: [itemOf(1, 'setl_1', '2026-09-02'), itemOf(2, 'setl_2', '2026-09-04')],
  });

describe('a complete answer', () => {
  it('has no gaps', async () => {
    const { source } = twoSettlements();
    const bundle = await fetchBundle(source, window);
    expect(bundle.gaps).toEqual([]);
    expect(nothingFetched(bundle)).toBe(false);
  });

  it('is not an outage when the window is simply empty', async () => {
    const bundle = await fetchBundle(stubSource().source, window);
    expect(bundle.gaps).toEqual([]);
    expect(nothingFetched(bundle)).toBe(false);
  });
});

describe('one entity that Razorpay would not give', () => {
  it('payments: the rest still arrives, refunds are not asked for, and both are listed', async () => {
    const { source, calls } = twoSettlements();
    const bundle = await fetchBundle(withFailures(source, { payments: down() }), window);

    expect(bundle.payments).toEqual([]);
    expect(bundle.settlements.map((s) => s.record.settlementId)).toEqual(['setl_1', 'setl_2']);
    expect(bundle.items).toHaveLength(2);
    expect(calls.refunds).toEqual([]);
    expect(bundle.gaps.map((g) => [g.entity, g.kind])).toEqual([
      ['payments', 'not_fetched'],
      ['refunds', 'not_fetched'],
    ]);
    expect(bundle.gaps[0]?.detail).toContain('payments were not fetched');
    expect(bundle.gaps[0]?.detail).toContain('503 SERVER_ERROR');
    expect(bundle.gaps[0]?.detail).toContain('after 5 tries');
    expect(bundle.gaps[1]?.detail).toBe(
      'refunds were not fetched: the payments they belong to are missing',
    );
    expect(bundle.provenance.map((p) => p.entity)).toEqual(['settlements', 'settlement_recon']);
    expect(nothingFetched(bundle)).toBe(false);
  });

  it('refunds: payments are kept', async () => {
    const { source } = twoSettlements();
    const bundle = await fetchBundle(withFailures(source, { refunds: down(429) }), window);
    expect(bundle.gaps).toHaveLength(1);
    expect(bundle.gaps[0]).toMatchObject({ entity: 'refunds', kind: 'not_fetched', days: [] });
    expect(bundle.gaps[0]?.detail).toContain('429');
    expect(bundle.provenance.map((p) => p.entity)).toEqual([
      'payments',
      'settlements',
      'settlement_recon',
    ]);
  });

  it('settlements: recon is not asked for, since its days come from them', async () => {
    const { source, calls } = twoSettlements();
    const bundle = await fetchBundle(withFailures(source, { settlements: down() }), window);
    expect(calls.recon).toEqual([]);
    expect(bundle.items).toEqual([]);
    expect(bundle.gaps.map((g) => g.entity)).toEqual(['settlements', 'settlement_recon']);
    expect(bundle.gaps[1]?.detail).toContain('the days to ask for are unknown');
    expect(bundle.provenance.map((p) => p.entity)).toEqual(['payments', 'refunds']);
  });

  it('says nothing fetched, and imports nothing, when Razorpay is down for all of it', async () => {
    const { source } = twoSettlements();
    const bundle = await fetchBundle(
      withFailures(source, { payments: down(), settlements: down() }),
      window,
    );
    expect(bundle.gaps.map((g) => g.entity)).toEqual([
      'payments',
      'refunds',
      'settlements',
      'settlement_recon',
    ]);
    expect(nothingFetched(bundle)).toBe(true);
  });
});

describe('recon days that fail', () => {
  const failing = (days: string[]) => (date: string) => (days.includes(date) ? down() : undefined);

  it('are listed by day, and the other days are kept', async () => {
    const { source } = twoSettlements();
    const asked: string[] = [];
    const bundle = await fetchBundle(
      withFailures(source, { recon: failing(['2026-09-03']) }, asked),
      window,
    );
    expect(asked).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(bundle.items.map((i) => i.record.sourceRef)).toEqual(['recon-1', 'recon-2']);
    expect(bundle.gaps).toHaveLength(1);
    expect(bundle.gaps[0]).toMatchObject({
      entity: 'settlement_recon',
      kind: 'days_missing',
      days: ['2026-09-03'],
    });
    expect(bundle.gaps[0]?.detail).toContain('missing for 1 of 3 days (2026-09-03)');
  });

  it('stop being asked for after a streak, instead of costing a minute each', async () => {
    const { source } = stubSource({
      settlements: [settlementOn('setl_1', '2026-09-01'), settlementOn('setl_2', '2026-09-10')],
    });
    const asked: string[] = [];
    const bundle = await fetchBundle(withFailures(source, { recon: () => down() }, asked), window);

    expect(RECON_FAILURE_STREAK).toBe(3);
    expect(asked).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const [gap] = bundle.gaps;
    expect(gap?.kind).toBe('days_missing');
    expect(gap?.days).toHaveLength(10); // all ten days: three failed, seven never asked
    expect(gap?.detail).toContain('10 of 10 days');
    expect(gap?.detail).toContain('stopped asking after 3 failures in a row');
    expect(gap?.detail).toContain('7 days were not requested');
    // Settlements themselves were fine.
    expect(bundle.settlements).toHaveLength(2);
  });

  it('do not count against each other when a success comes between them', async () => {
    const { source } = stubSource({
      settlements: [settlementOn('setl_1', '2026-09-01'), settlementOn('setl_2', '2026-09-07')],
    });
    const asked: string[] = [];
    const bundle = await fetchBundle(
      withFailures(
        source,
        { recon: failing(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05']) },
        asked,
      ),
      window,
    );
    expect(asked).toHaveLength(7);
    expect(bundle.gaps[0]?.days).toEqual(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05']);
    expect(bundle.gaps[0]?.detail).not.toContain('stopped asking');
  });
});

describe('a list that stopped part-way', () => {
  it('keeps what arrived and lists the tail as missing', async () => {
    const { source } = twoSettlements();
    const cut: Incomplete = {
      what: 'payments',
      fetched: 300,
      reason: 'Razorpay API error 503 SERVER_ERROR: upstream is unavailable (after 5 tries)',
    };
    const partial: RazorpaySource = {
      ...source,
      fetchPayments: async (range) => {
        const full = await source.fetchPayments(range);
        return { ...full, provenance: { ...full.provenance, incomplete: [cut] } };
      },
    };
    const bundle = await fetchBundle(partial, window);
    expect(bundle.gaps).toEqual([
      {
        entity: 'payments',
        kind: 'cut_short',
        days: [],
        detail: 'payments stopped after 300 records: ' + cut.reason,
      },
    ]);
    // It was imported, so its provenance is there too.
    expect(bundle.provenance.map((p) => p.entity)).toContain('payments');
  });
});

describe('what is not an outage is not hidden as one', () => {
  it.each([
    ['a response we cannot read', new RazorpayResponseError('payments: unreadable')],
    ['a bad configuration', new RazorpayConfigError('live key refused')],
    ['a bug', new TypeError('x is not a function')],
  ])('%s still fails the import', async (_name, error) => {
    const { source } = twoSettlements();
    await expect(fetchBundle(withFailures(source, { payments: error }), window)).rejects.toBe(
      error,
    );
  });
});
