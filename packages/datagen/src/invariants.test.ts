import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type GenConfig, type PresetName, resolveConfig } from './config.js';
import {
  expectedCount,
  istOf,
  loadRaw,
  type Raw,
  recountAnomalies,
  type TruthRecordFile,
} from './datagen.fixtures.js';
import { renderToStrings } from './render/files.js';
import { generate } from './world/generate.js';

const ORDER_CODES = [
  'DUPLICATE_PAYMENT',
  'LEDGER_WITHOUT_PAYMENT',
  'PAYMENT_WITHOUT_LEDGER',
  'PARTIAL_REFUND_NETTED',
  'FULL_REFUND',
  'CHARGEBACK_ADJUSTMENT',
  'LEDGER_AMOUNT_EDITED',
  'TIMEZONE_DATE_SHIFT',
  'FEE_OVERCHARGE',
] as const;

interface Built {
  config: GenConfig;
  files: ReturnType<typeof renderToStrings>;
  raw: Raw;
}

function build(seed: number, preset: PresetName, overrides = {}): Built {
  const config = resolveConfig(seed, preset, overrides);
  const files = renderToStrings(generate(config));
  return { config, files, raw: loadRaw(files) };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const big = (n: number | string): bigint => BigInt(n);

/** Every violation of "a settlement equals its composition, to the paise", from raw files only. */
function compositionViolations(raw: Raw, config: GenConfig): string[] {
  const bad: string[] = [];
  const paymentById = new Map(raw.payments.map((p) => [p.id, p]));
  const refundById = new Map(raw.refunds.map((r) => [r.id, r]));
  const itemsBySettlement = new Map<string, Raw['items']>();
  for (const item of raw.items) {
    const list = itemsBySettlement.get(item.settlement_id);
    if (list) list.push(item);
    else itemsBySettlement.set(item.settlement_id, [item]);
  }

  for (const s of raw.settlements) {
    const items = itemsBySettlement.get(s.id) ?? [];
    const credits = items.reduce((sum, i) => sum + big(i.credit), 0n);
    const debits = items.reduce((sum, i) => sum + big(i.debit), 0n);
    if (credits - debits !== big(s.amount))
      bad.push(`${s.id}: ${credits} - ${debits} != ${s.amount}`);
    if (s.fees !== 0 || s.tax !== 0) bad.push(`${s.id}: settlement fees/tax must be 0`);
    if (big(s.amount) <= 0n) bad.push(`${s.id}: non-positive net`);
  }

  const seenPayment = new Set<string>();
  const seenRefund = new Set<string>();
  for (const i of raw.items) {
    const amount = big(i.amount);
    if (i.type === 'payment') {
      const p = paymentById.get(i.entity_id);
      if (!p || p.fee === null || p.tax === null) {
        bad.push(`${i.entity_id}: payment line without a captured payment`);
        continue;
      }
      if (seenPayment.has(p.id)) bad.push(`${p.id}: settled twice`);
      seenPayment.add(p.id);
      if (big(i.credit) !== big(p.amount) - big(p.fee)) bad.push(`${p.id}: credit != amount - fee`);
      if (i.debit !== 0) bad.push(`${p.id}: payment line has a debit`);
      if (i.fee !== p.fee || i.tax !== p.tax || amount !== big(p.amount))
        bad.push(`${p.id}: line disagrees with payment`);
    } else if (i.type === 'refund') {
      const r = refundById.get(i.entity_id);
      if (!r) {
        bad.push(`${i.entity_id}: refund line without a refund`);
        continue;
      }
      if (seenRefund.has(r.id)) bad.push(`${r.id}: refund debited twice`);
      seenRefund.add(r.id);
      if (amount !== big(r.amount) || big(i.debit) !== big(r.amount))
        bad.push(`${r.id}: debit != refund amount`);
      if (i.credit !== 0 || i.fee !== 0 || i.tax !== 0)
        bad.push(`${r.id}: refund line must carry no credit/fee/tax`);
      if (i.payment_id !== r.payment_id) bad.push(`${r.id}: refund line names the wrong payment`);
    } else if (i.type === 'adjustment') {
      if (big(i.debit) !== amount || i.credit !== 0)
        bad.push(`${i.entity_id}: adjustment must be a pure debit`);
      if (i.credit_type !== undefined)
        bad.push(`${i.entity_id}: adjustment lines carry no credit_type`);
      const named = /pay_[A-Za-z0-9]{14}/.exec(i.description ?? '')?.[0];
      const p = named === undefined ? undefined : paymentById.get(named);
      if (!p || big(p.amount) !== amount)
        bad.push(`${i.entity_id}: adjustment does not name a payment of the same amount`);
    }
  }
  for (const p of raw.payments) {
    const captured = p.status !== 'failed';
    if (captured && !seenPayment.has(p.id)) bad.push(`${p.id}: captured but never settled`);
    if (!captured && seenPayment.has(p.id)) bad.push(`${p.id}: failed but settled`);
  }
  for (const r of raw.refunds) if (!seenRefund.has(r.id)) bad.push(`${r.id}: refund never debited`);

  // Fee maths with oracles that do not use @ziro/core: base fee half-up, GST half-up on the base.
  for (const p of raw.payments) {
    if (p.fee === null || p.tax === null) continue;
    const base = big(p.fee) - big(p.tax);
    const contracted =
      (big(p.amount) * big(config.feeBps[p.method as 'card' | 'upi' | 'netbanking']) + 5000n) /
      10_000n;
    if ((base * big(config.gstBps) + 5000n) / 10_000n !== big(p.tax))
      bad.push(`${p.id}: tax is not 18% of the base fee`);
    if (base < contracted) bad.push(`${p.id}: charged below the contracted fee`);
  }

  // One bank credit per settlement, for exactly the net amount.
  const settlementAmounts = raw.settlements
    .map((s) => big(s.amount))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const creditAmounts = raw.bank
    .filter((b) => b.credit !== null && b.narration.includes('RAZORPAY SOFTWARE'))
    .map((b) => b.credit as bigint)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (settlementAmounts.join() !== creditAmounts.join())
    bad.push('settlement amounts != Razorpay bank credits');
  return bad;
}

function bankViolations(raw: Raw, config: GenConfig): string[] {
  const bad: string[] = [];
  let balance = config.bank.openingBalancePaise;
  let previous = '';
  for (const row of raw.bank) {
    balance += (row.credit ?? 0n) - (row.debit ?? 0n);
    if (balance !== row.balance)
      bad.push(`row ${row.row}: balance ${row.balance} != running ${balance}`);
    if (balance < 0n) bad.push(`row ${row.row}: negative balance`);
    if (row.credit !== null && row.debit !== null)
      bad.push(`row ${row.row}: both debit and credit`);
    if (row.credit === null && row.debit === null)
      bad.push(`row ${row.row}: neither debit nor credit`);
    if (row.value_date < previous) bad.push(`row ${row.row}: not in date order`);
    previous = row.value_date;
  }

  // A business spends a fraction of what it takes in: debits must stay a bounded share of credits
  // (the configured share, plus 5 points for whole-rupee rounding and the ₹10 floor on a debit).
  const credits = raw.bank.reduce((sum, row) => sum + (row.credit ?? 0n), 0n);
  const debits = raw.bank.reduce((sum, row) => sum + (row.debit ?? 0n), 0n);
  const ceiling = (credits * BigInt(config.bank.debitShareBps + 500)) / 10_000n;
  if (debits > ceiling) {
    bad.push(
      `debits ${debits} exceed ${config.bank.debitShareBps / 100}% (+5) of credits ${credits}`,
    );
  }
  return bad;
}

describe.each([
  ['demo', 42],
  ['eval', 42],
  ['eval', 7],
] as const)('%s preset, seed %i', (preset, seed) => {
  const built = build(seed, preset);
  const { config, files, raw } = built;
  const truth = raw.truth;

  it('is byte-identical for the same seed, and different for another', () => {
    const again = renderToStrings(generate(config));
    for (const [name, text] of files) {
      expect(sha(again.get(name) ?? ''), name).toBe(sha(text));
    }
    const other = renderToStrings(generate(resolveConfig(seed + 1, preset)));
    expect(sha(other.get('truth.json') ?? '')).not.toBe(sha(files.get('truth.json') ?? ''));
    expect(sha(other.get('ledger.csv') ?? '')).not.toBe(sha(files.get('ledger.csv') ?? ''));
  });

  it('has the preset size and writes Razorpay lists newest first', () => {
    expect(raw.ledger).toHaveLength(config.orders);
    for (const list of [raw.payments, raw.orders, raw.refunds, raw.settlements]) {
      for (let i = 1; i < list.length; i++) {
        expect((list[i - 1] as { created_at: number }).created_at).toBeGreaterThanOrEqual(
          (list[i] as { created_at: number }).created_at,
        );
      }
    }
  });

  it('every settlement equals its composition to the paise', () => {
    expect(compositionViolations(raw, config)).toEqual([]);
  });

  it('keeps an exact, never-negative running bank balance', () => {
    expect(bankViolations(raw, config)).toEqual([]);
  });

  it('anomaly counts match the configured rates', () => {
    const got = recountAnomalies(raw, config);
    const want: Record<string, number> = {};
    for (const code of ORDER_CODES) want[code] = expectedCount(config.rates[code], config.orders);
    want['SETTLEMENT_DELAYED'] = expectedCount(
      config.rates.SETTLEMENT_DELAYED,
      raw.settlements.length,
    );
    want['UTR_MISSING_OR_GARBLED'] = expectedCount(
      config.rates.UTR_MISSING_OR_GARBLED,
      raw.settlements.length,
    );
    for (const [code, expected] of Object.entries(want)) {
      const actual = got[code] ?? 0;
      expect(
        Math.abs(actual - expected),
        `${code}: recounted ${actual}, rate says ${expected}`,
      ).toBeLessThanOrEqual(1);
      expect(actual, `${code} should in fact be exact`).toBe(expected);
    }
    // The truth file's own tally agrees with the raw recount.
    for (const [code, expected] of Object.entries(want)) {
      expect(truth.meta.counts.anomalies[code] ?? 0, code).toBe(expected);
    }
  });

  it('truth.json covers 100% of records, exactly', () => {
    const expected = new Set<string>();
    for (const l of raw.ledger) expected.add(`ledger_entry:${l.order_ref}`);
    for (const o of raw.orders) expected.add(`rzp_order:${o.id}`);
    for (const p of raw.payments) expected.add(`rzp_payment:${p.id}`);
    for (const r of raw.refunds) expected.add(`rzp_refund:${r.id}`);
    for (const s of raw.settlements) expected.add(`rzp_settlement:${s.id}`);
    for (const i of raw.items) expected.add(`settlement_item:${i.settlement_id}:${i.entity_id}`);
    for (const b of raw.bank) expected.add(`bank_line:row-${b.row}`);

    const covered = truth.records.map((r) => `${r.type}:${r.key}`);
    expect(new Set(covered).size, 'truth has duplicate records').toBe(covered.length);
    expect(covered.length).toBe(expected.size);
    expect(covered.filter((k) => !expected.has(k))).toEqual([]);
    expect([...expected].filter((k) => !new Set(covered).has(k))).toEqual([]);
  });

  it('truth groups are self-consistent', () => {
    const groups = new Map(truth.groups.map((g) => [g.id, g]));
    expect(groups.size).toBe(truth.groups.length);
    for (const record of truth.records) {
      if (record.groupId === null) continue;
      const group = groups.get(record.groupId);
      expect(group, `${record.type}:${record.key} -> ${record.groupId}`).toBeDefined();
      expect(group?.members).toContain(`${record.type}:${record.key}`);
    }
    for (const group of truth.groups) {
      const kinds = group.members.map((m) => m.split(':')[0]);
      if (group.kind === 'payout') {
        expect(
          kinds.filter((k) => k === 'rzp_settlement'),
          group.id,
        ).toHaveLength(1);
        expect(
          kinds.filter((k) => k === 'bank_line'),
          group.id,
        ).toHaveLength(1);
        const c = group.composition;
        expect(c['settlement'], group.id).toBe(c['bank']);
        const net =
          big(c['paymentsGross'] ?? '0') -
          big(c['feesDeducted'] ?? '0') -
          big(c['refundsDebited'] ?? '0') -
          big(c['adjustmentsDebited'] ?? '0');
        expect(net.toString(), `${group.id} composition`).toBe(c['settlement']);
        expect(group.structural).toContain('FEE_GST_DEDUCTION');
      } else {
        expect(
          kinds.filter((k) => k === 'ledger_entry'),
          group.id,
        ).toHaveLength(1);
        if (group.anomalies.length === 0) {
          // A clean order: the ledger equals the payments, with nothing refunded.
          expect(group.composition['ledger'], group.id).toBe(group.composition['payments']);
          expect(group.composition['refunds'] ?? '0').toBe('0');
        }
      }
    }
  });

  it('labels leftovers and noise with no group, and everything else with one', () => {
    const noGroup = new Set([
      'cash_order',
      'payment_link',
      'payment_link_order',
      'failed_attempt',
      'noise',
      'decoy',
    ]);
    const dupRefunded = new Map<string, boolean>();
    for (const a of truth.anomalies) {
      if (a.reasonCode === 'DUPLICATE_PAYMENT') {
        for (const r of a.records)
          dupRefunded.set(`${r.type}:${r.key}`, a.detail['refunded'] === 'true');
      }
    }
    for (const r of truth.records) {
      const key = `${r.type}:${r.key}`;
      if (noGroup.has(r.role)) expect(r.groupId, `${key} (${r.role})`).toBeNull();
      else if (r.role === 'duplicate' || r.role === 'retry_order') {
        expect(r.groupId === null, key).toBe(dupRefunded.get(key) === false);
      } else expect(r.groupId, `${key} (${r.role})`).not.toBeNull();
    }
  });

  it('records reason codes only on records that take part in an anomaly', () => {
    const inAnomaly = new Set(
      truth.anomalies.flatMap((a) => a.records.map((r) => `${r.type}:${r.key}`)),
    );
    const codeOf = new Map(truth.anomalies.map((a) => [a.id, a.reasonCode]));
    for (const r of truth.records) {
      const key = `${r.type}:${r.key}`;
      expect(r.reasonCodes.length > 0, key).toBe(inAnomaly.has(key));
      expect([...new Set(r.anomalyIds.map((id) => codeOf.get(id)))].sort(), key).toEqual(
        r.reasonCodes,
      );
    }
    for (const a of truth.anomalies) expect(a.records.length, a.id).toBeGreaterThan(0);
  });

  it('injects exactly the configured number of hostile strings, in the labelled fields', () => {
    const injected = truth.records.filter(
      (r): r is TruthRecordFile & { injection: NonNullable<TruthRecordFile['injection']> } =>
        r.injection !== null,
    );
    expect(injected).toHaveLength(config.injections);
    expect(truth.meta.counts.injections).toBe(config.injections);
    expect(new Set(injected.map((r) => `${r.type}:${r.key}`)).size).toBe(injected.length);

    for (const r of injected) {
      const { field, text } = r.injection;
      if (r.type === 'ledger_entry') {
        expect(field).toBe('memo');
        expect(raw.ledger.find((l) => l.order_ref === r.key)?.memo).toBe(text);
      } else if (r.type === 'bank_line') {
        expect(field).toBe('narration');
        expect(raw.bank[Number(r.key.slice(4)) - 1]?.narration).toContain(text);
      } else if (r.type === 'rzp_payment') {
        expect(field).toBe('notes');
        expect(JSON.stringify(raw.payments.find((p) => p.id === r.key)?.notes)).toContain(
          JSON.stringify(text).slice(1, -1),
        );
      } else if (r.type === 'rzp_refund') {
        expect(field).toBe('notes');
        expect(JSON.stringify(raw.refunds.find((x) => x.id === r.key)?.notes)).toContain(
          JSON.stringify(text).slice(1, -1),
        );
      } else throw new Error(`unexpected injection target ${r.type}`);
    }
    // Injection never changes the true labels: the record keeps its own group and reasons.
    expect(injected.some((r) => r.groupId !== null)).toBe(true);
  });

  it('shows timezone-shifted orders crossing IST midnight, and only those', () => {
    const shifted = truth.anomalies.filter((a) => a.reasonCode === 'TIMEZONE_DATE_SHIFT');
    expect(shifted).toHaveLength(expectedCount(config.rates.TIMEZONE_DATE_SHIFT, config.orders));
    const orderByReceipt = new Map(
      raw.orders.flatMap((o) => (o.receipt === null ? [] : [[o.receipt, o] as const])),
    );
    const paymentByOrder = new Map(
      raw.payments.filter((p) => p.status !== 'failed').map((p) => [p.order_id, p]),
    );
    for (const a of shifted) {
      const ref = a.detail['orderRef'] as string;
      const ledger = raw.ledger.find((l) => l.order_ref === ref);
      const order = orderByReceipt.get(ref);
      const payment = paymentByOrder.get(order?.id ?? null);
      expect(ledger && order && payment, ref).toBeTruthy();
      const placed = istOf(order?.created_at ?? 0);
      const paid = istOf(payment?.created_at ?? 0);
      expect(placed.secondOfDay, `${ref} placed 23:30-23:59 IST`).toBeGreaterThanOrEqual(
        23 * 3600 + 30 * 60,
      );
      expect(placed.date).toBe(ledger?.order_date);
      expect(paid.date, `${ref} paid after midnight`).not.toBe(ledger?.order_date);
    }
  });

  it('runs a normal world: all three methods, fees at the contracted rate, T+2 settlement', () => {
    const methods = new Set(raw.payments.map((p) => p.method));
    expect(methods).toEqual(new Set(['card', 'upi', 'netbanking']));
    const overcharged = new Set(
      truth.anomalies
        .filter((a) => a.reasonCode === 'FEE_OVERCHARGE')
        .map((a) => a.detail['paymentId']),
    );
    for (const p of raw.payments) {
      if (p.fee === null || p.tax === null || overcharged.has(p.id)) continue;
      const base = big(p.fee) - big(p.tax);
      expect(base, p.id).toBe(
        (big(p.amount) * big(config.feeBps[p.method as 'card' | 'upi' | 'netbanking']) + 5000n) /
          10_000n,
      );
    }
    for (const id of overcharged) {
      const p = raw.payments.find((x) => x.id === id);
      const contracted =
        (big(p?.amount ?? 0) *
          big(config.feeBps[(p?.method ?? 'card') as 'card' | 'upi' | 'netbanking']) +
          5000n) /
        10_000n;
      expect(big(p?.fee ?? 0) - big(p?.tax ?? 0), String(id)).toBeGreaterThan(contracted);
    }
  });
});

describe('every preset is exercised', () => {
  it('demo shows every anomaly at least once', () => {
    const { raw, config } = build(42, 'demo');
    const got = recountAnomalies(raw, config);
    for (const code of [...ORDER_CODES, 'SETTLEMENT_DELAYED', 'UTR_MISSING_OR_GARBLED']) {
      expect(got[code] ?? 0, code).toBeGreaterThanOrEqual(1);
    }
  });

  it('plants same-amount decoy credits that make a damaged-UTR credit ambiguous', () => {
    const { raw } = build(42, 'eval');
    const decoys = raw.truth.records.filter((r) => r.role === 'decoy');
    expect(decoys.length).toBeGreaterThanOrEqual(1);
    const ambiguous = raw.truth.records.filter(
      (r) => r.type === 'bank_line' && r.ambiguousWith.length > 0,
    );
    expect(ambiguous.length).toBeGreaterThanOrEqual(decoys.length * 2);
    for (const r of ambiguous) {
      const own = raw.bank[Number(r.key.slice(4)) - 1];
      for (const other of r.ambiguousWith)
        expect(raw.bank[Number(other.slice(4)) - 1]?.credit).toBe(own?.credit);
    }
  });

  it('generates a reduced stress run that still satisfies the invariants', () => {
    // Same noise-to-settlement density as the real stress preset (about 200 noise lines per
    // settlement). That density is what drains an account if debits are not tied to income.
    const { raw, config } = build(5, 'stress', {
      orders: 4000,
      days: 150,
      bank: { noiseLines: 20_000 },
      injections: 30,
    });
    expect(raw.bank.length).toBeGreaterThan(20_000);
    expect(compositionViolations(raw, config)).toEqual([]);
    expect(bankViolations(raw, config)).toEqual([]);
  });
});

describe('seed sweeps', () => {
  it('generates valid demo data for 60 different seeds', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { raw, config } = build(seed, 'demo');
      expect(compositionViolations(raw, config), `demo seed ${seed}`).toEqual([]);
      expect(bankViolations(raw, config), `demo seed ${seed}`).toEqual([]);
      const got = recountAnomalies(raw, config);
      expect(got['LEDGER_WITHOUT_PAYMENT'], `demo seed ${seed}`).toBe(
        expectedCount(config.rates.LEDGER_WITHOUT_PAYMENT, config.orders),
      );
      expect(raw.truth.records.length).toBeGreaterThan(0);
    }
  });

  it('generates valid eval data for 6 different seeds', () => {
    for (const seed of [1, 2, 3, 99, 12345, 4_000_000_000]) {
      const { raw, config } = build(seed, 'eval');
      expect(compositionViolations(raw, config), `eval seed ${seed}`).toEqual([]);
      expect(bankViolations(raw, config), `eval seed ${seed}`).toEqual([]);
    }
  });
});

// The full ~100k-row stress run is slow and large; run it with STRESS=1 (npm run test:stress).
describe.runIf(process.env['STRESS'] === '1')('full stress preset', () => {
  it('generates ~100k ledger rows and ~100k bank lines with every invariant intact', () => {
    const started = Date.now();
    const { raw, config } = build(42, 'stress');
    process.stdout.write(
      `stress: ${raw.ledger.length} ledger rows, ${raw.bank.length} bank lines in ${Date.now() - started} ms\n`,
    );
    expect(raw.ledger).toHaveLength(100_000);
    expect(raw.bank.length).toBeGreaterThan(95_000);
    expect(raw.bank.length).toBeLessThan(105_000);
    expect(compositionViolations(raw, config)).toEqual([]);
    expect(bankViolations(raw, config)).toEqual([]);
  }, 600_000);
});
