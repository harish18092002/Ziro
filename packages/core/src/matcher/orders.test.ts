import { describe, expect, it } from 'vitest';
import { matcherConfig, RULE_IDS } from './types.js';
import { runMatcher } from './run.js';
import { emptyInput, ledger, payment, refund } from './matcher.fixtures.js';

const ids = (...records: { id: string }[]) => records.map((r) => r.id).sort();
const subjects = (out: ReturnType<typeof runMatcher>) =>
  out.exceptions.map((e) => [e.subject.recordType, e.subject.recordId, e.reasonCode, e.cause]);

describe('T1: a ledger entry and the captured payment for its order', () => {
  it('matches on order reference and amount, and records tier and rule', () => {
    const l = ledger('ORD-1', 100_000);
    const p = payment('pay_1', 'ORD-1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p] });

    expect(out.exceptions).toEqual([]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({
      kind: 'order',
      tier: 'T1',
      ruleId: RULE_IDS.T1,
      reasonCode: null,
      residual: 0n,
      evidence: { ledgerAmount: 100_000n, paymentAmount: 100_000n, refundsTotal: 0n },
    });
    expect(out.groups[0]?.members.map((m) => m.recordId)).toEqual([l.id, p.id]);
    expect(out.stats.matched.ledger_entry).toEqual({ total: 1, matched: 1 });
  });

  it('cleans both references the same way: case, spaces and invisible characters', () => {
    const l = ledger('ORD-1', 500);
    const p = payment('pay_1', ' ord-1 ', 500);
    const q = ledger('ORD-2', 700);
    const r = payment('pay_2', 'ord\u200B-2', 700);
    const out = runMatcher({ ...emptyInput(), ledger: [l, q], payments: [p, r] });
    expect(out.groups.map((g) => g.tier)).toEqual(['T1', 'T1']);
    expect(out.exceptions).toEqual([]);
  });

  it.each([1, -1])('never matches an amount that is %i paise out: zero tolerance', (off) => {
    const l = ledger('ORD-1', 100_000);
    const p = payment('pay_1', 'ORD-1', 100_000 + off);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p] });

    expect(out.groups).toEqual([]);
    expect(out.exceptions).toHaveLength(2);
    const ledgerException = out.exceptions.find((e) => e.subject.recordType === 'ledger_entry');
    const paymentException = out.exceptions.find((e) => e.subject.recordType === 'rzp_payment');
    expect(ledgerException).toMatchObject({
      reasonCode: 'UNKNOWN',
      cause: 'receipt_amount_differs',
      amountAtStake: BigInt(-off),
      candidates: [{ recordType: 'rzp_payment', recordId: p.id }],
    });
    expect(paymentException).toMatchObject({
      amountAtStake: BigInt(off),
      candidates: [{ recordType: 'ledger_entry', recordId: l.id }],
    });
  });

  it('says LEDGER_WITHOUT_PAYMENT when no payment of any status carries the reference', () => {
    const l = ledger('ORD-1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l] });
    expect(out.exceptions).toMatchObject([
      {
        reasonCode: 'LEDGER_WITHOUT_PAYMENT',
        cause: 'ledger_has_no_payment',
        amountAtStake: 100_000n,
        candidates: [],
      },
    ]);
  });

  it('does not call it LEDGER_WITHOUT_PAYMENT when the only payment was never captured', () => {
    const l = ledger('ORD-1', 100_000);
    const failed = payment('pay_1', 'ORD-1', 100_000, { status: 'failed', captured: false });
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [failed] });
    expect(out.exceptions).toMatchObject([
      {
        reasonCode: 'UNKNOWN',
        cause: 'ledger_payment_not_captured',
        candidates: [{ recordType: 'rzp_payment', recordId: failed.id }],
      },
    ]);
    expect(out.ignored).toMatchObject([{ why: 'payment_not_captured' }]);
  });

  it('ignores a failed attempt next to the captured payment of the same order', () => {
    const l = ledger('ORD-1', 100_000);
    const failed = payment('pay_1', 'ORD-1', 100_000, { status: 'failed', captured: false });
    const good = payment('pay_2', 'ORD-1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [failed, good] });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.members.map((m) => m.recordId)).toEqual([l.id, good.id]);
    expect(out.ignored.map((i) => i.subject.recordId)).toEqual([failed.id]);
    expect(out.exceptions).toEqual([]);
  });

  it('says PAYMENT_WITHOUT_LEDGER for a captured payment nothing in the ledger accounts for', () => {
    const noLedger = payment('pay_1', 'LINK-1', 30_000);
    const noReceipt = payment('pay_2', null, 40_000);
    const out = runMatcher({ ...emptyInput(), payments: [noLedger, noReceipt] });
    expect(subjects(out).map((s) => s.slice(2))).toEqual([
      ['PAYMENT_WITHOUT_LEDGER', 'payment_has_no_ledger'],
      ['PAYMENT_WITHOUT_LEDGER', 'payment_has_no_ledger'],
    ]);
  });

  it('sends a ledger entry whose reference cleans to nothing to an exception, not a guess', () => {
    const l = ledger('\u200B', 100);
    const out = runMatcher({ ...emptyInput(), ledger: [l] });
    expect(out.exceptions).toMatchObject([
      { reasonCode: 'UNKNOWN', cause: 'ledger_has_no_reference' },
    ]);
  });
});

describe('T1: ambiguity is an exception with every candidate attached', () => {
  it('two captured payments of the same amount for one order: DUPLICATE_PAYMENT, nothing matched', () => {
    const l = ledger('ORD-1', 100_000);
    const a = payment('pay_1', 'ORD-1', 100_000);
    const b = payment('pay_2', 'ORD-1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [a, b] });

    expect(out.groups).toEqual([]);
    expect(out.exceptions).toHaveLength(3);
    for (const e of out.exceptions) {
      expect(e).toMatchObject({ reasonCode: 'DUPLICATE_PAYMENT', cause: 'receipt_ambiguous' });
      expect(e.candidates).toHaveLength(2); // the other two records
    }
    expect(ids(...out.exceptions.map((e) => ({ id: e.subject.recordId })))).toEqual(ids(l, a, b));
  });

  it('two captured payments of different amounts: UNKNOWN, still nothing matched', () => {
    const l = ledger('ORD-1', 100_000);
    const out = runMatcher({
      ...emptyInput(),
      ledger: [l],
      payments: [payment('pay_1', 'ORD-1', 100_000), payment('pay_2', 'ORD-1', 60_000)],
    });
    expect(out.groups).toEqual([]);
    expect(out.exceptions.map((e) => e.reasonCode)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  });

  it('two ledger entries for one reference are never resolved by position', () => {
    const out = runMatcher({
      ...emptyInput(),
      ledger: [ledger('ORD-1', 100), ledger('ord-1', 100)],
      payments: [payment('pay_1', 'ORD-1', 100)],
    });
    expect(out.groups).toEqual([]);
    expect(out.exceptions).toHaveLength(3);
    expect(out.exceptions.every((e) => e.cause === 'receipt_ambiguous')).toBe(true);
    // One payment is not a duplicate payment, whatever the ledger looks like.
    expect(out.exceptions.every((e) => e.reasonCode === 'UNKNOWN')).toBe(true);
  });
});

describe('T1: exceptions stay readable', () => {
  it('carry at most 50 candidates and say how many there were', () => {
    const l = ledger('ORD-1', 100);
    const many = Array.from({ length: 60 }, (_, i) => payment(`pay_${i}`, 'ORD-1', 100 + i));
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: many });
    const exception = out.exceptions.find((e) => e.subject.recordId === l.id);
    expect(exception?.candidates).toHaveLength(50);
    expect(exception?.candidateCount).toBe(60);
  });
});

describe('T1: retried checkouts', () => {
  const l = ledger('ORD-1', 100_000);
  const original = payment('pay_1', 'ORD-1', 100_000);

  it('a retry receipt for an order already matched at the same amount is DUPLICATE_PAYMENT', () => {
    const retry = payment('pay_2', 'ORD-1-R1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [original, retry] });
    expect(out.groups).toHaveLength(1);
    expect(out.exceptions).toMatchObject([
      {
        reasonCode: 'DUPLICATE_PAYMENT',
        cause: 'payment_is_retry_duplicate',
        subject: { recordId: retry.id },
        amountAtStake: 100_000n,
      },
    ]);
    expect(out.exceptions[0]?.candidates.map((c) => c.recordId).sort()).toEqual(ids(l, original));
  });

  it('a retry at a different amount is not called a duplicate', () => {
    const retry = payment('pay_2', 'ORD-1-R1', 90_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [original, retry] });
    expect(out.exceptions).toMatchObject([
      { reasonCode: 'UNKNOWN', cause: 'payment_retry_of_other_amount' },
    ]);
  });

  it('a retry of an order that is itself unresolved stays UNKNOWN', () => {
    const edited = ledger('ORD-1', 95_000);
    const retry = payment('pay_2', 'ORD-1-R1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [edited], payments: [original, retry] });
    const retryException = out.exceptions.find((e) => e.subject.recordId === retry.id);
    expect(retryException).toMatchObject({
      reasonCode: 'UNKNOWN',
      cause: 'payment_retry_of_unresolved_order',
    });
  });

  it('is only a PAYMENT_WITHOUT_LEDGER when the rule is switched off or no base order exists', () => {
    const retry = payment('pay_2', 'ORD-1-R1', 100_000);
    const off = runMatcher(
      { ...emptyInput(), ledger: [l], payments: [original, retry] },
      matcherConfig({ retryReceiptPattern: null }),
    );
    expect(off.exceptions).toMatchObject([{ reasonCode: 'PAYMENT_WITHOUT_LEDGER' }]);
    const none = runMatcher({ ...emptyInput(), payments: [payment('pay_3', 'ORD-9-R1', 100)] });
    expect(none.exceptions).toMatchObject([{ reasonCode: 'PAYMENT_WITHOUT_LEDGER' }]);
  });
});

describe('T1: refunds travel with their payment', () => {
  const l = ledger('ORD-1', 100_000);
  const p = payment('pay_1', 'ORD-1', 100_000);

  it('a full refund joins the group and explains it as FULL_REFUND', () => {
    const r = refund('rfnd_1', 'pay_1', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: [r] });
    expect(out.groups[0]).toMatchObject({ reasonCode: 'FULL_REFUND', residual: 0n });
    expect(out.groups[0]?.members.map((m) => m.recordId).sort()).toEqual(ids(l, p, r));
    expect(out.groups[0]?.evidence).toMatchObject({ refundsTotal: 100_000n });
    expect(out.exceptions).toEqual([]);
  });

  it('a partial refund is PARTIAL_REFUND_NETTED', () => {
    const r = refund('rfnd_1', 'pay_1', 25_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: [r] });
    expect(out.groups[0]).toMatchObject({ reasonCode: 'PARTIAL_REFUND_NETTED' });
  });

  it('two partial refunds that add up to the payment are a FULL_REFUND', () => {
    const rs = [refund('rfnd_1', 'pay_1', 40_000), refund('rfnd_2', 'pay_1', 60_000)];
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: rs });
    expect(out.groups[0]).toMatchObject({ reasonCode: 'FULL_REFUND' });
    expect(out.groups[0]?.members).toHaveLength(4);
  });

  it('refunds worth more than the payment are exceptions and are not attached', () => {
    const rs = [refund('rfnd_1', 'pay_1', 70_000), refund('rfnd_2', 'pay_1', 40_000)];
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: rs });
    expect(out.groups[0]?.members).toHaveLength(2);
    expect(out.groups[0]?.reasonCode).toBeNull();
    expect(out.exceptions.map((e) => e.cause)).toEqual([
      'refund_exceeds_payment',
      'refund_exceeds_payment',
    ]);
  });

  it('lists the refunds of a payment in a fixed order whatever order they arrive in', () => {
    const rs = [
      refund('rfnd_2', 'pay_1', 10),
      refund('rfnd_1', 'pay_1', 20),
      refund('rfnd_3', 'pay_1', 30),
    ];
    const forward = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: rs });
    const backward = runMatcher({
      ...emptyInput(),
      ledger: [l],
      payments: [p],
      refunds: [...rs].reverse(),
    });
    expect(backward).toEqual(forward);
    expect(forward.groups[0]?.members).toHaveLength(5);
  });

  it('ignores a failed refund', () => {
    const r = refund('rfnd_1', 'pay_1', 25_000, { status: 'failed' });
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p], refunds: [r] });
    expect(out.groups[0]?.reasonCode).toBeNull();
    expect(out.ignored).toMatchObject([{ why: 'refund_failed' }]);
  });

  it('folds the refunds of an unmatched payment into that payment`s exception', () => {
    const dup = payment('pay_2', 'ORD-1-R1', 100_000);
    const r = refund('rfnd_9', 'pay_2', 100_000);
    const out = runMatcher({ ...emptyInput(), ledger: [l], payments: [p, dup], refunds: [r] });
    const exception = out.exceptions.find((e) => e.subject.recordId === dup.id);
    expect(exception?.candidates.map((c) => c.recordId)).toContain(r.id);
    expect(out.ignored).toMatchObject([
      { why: 'refund_follows_payment_exception', subject: { recordId: r.id } },
    ]);
    expect(out.groups[0]?.members.map((m) => m.recordId)).not.toContain(r.id);
  });

  it('flags a refund whose payment is not in the data', () => {
    const r = refund('rfnd_1', 'pay_missing', 100);
    const out = runMatcher({ ...emptyInput(), refunds: [r] });
    expect(out.exceptions).toMatchObject([
      { reasonCode: 'UNKNOWN', cause: 'refund_without_payment', candidates: [] },
    ]);
  });
});

describe('T1: a late-night order and a payment just after midnight', () => {
  // The order is dated 1 Sept; the payment is 00:06 IST on 2 Sept (18:36 UTC on 1 Sept).
  const l = ledger('ORD-1', 100_000, { businessDate: '2026-09-01' });
  const after = (createdAt: string, businessDate: string) =>
    payment('pay_1', 'ORD-1', 100_000, { createdAt, businessDate });

  it('is annotated TIMEZONE_DATE_SHIFT, and still matched', () => {
    const out = runMatcher({
      ...emptyInput(),
      ledger: [l],
      payments: [after('2026-09-01T18:36:00Z', '2026-09-02')],
    });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.reasonCode).toBe('TIMEZONE_DATE_SHIFT');
  });

  it.each([
    ['a payment 90 minutes into the next day', '2026-09-01T20:00:00Z', '2026-09-02'], // 01:30 IST
    ['a payment hours into the next day', '2026-09-02T03:30:00Z', '2026-09-02'], // 09:00 IST
    ['a payment on the same day', '2026-09-01T06:00:00Z', '2026-09-01'],
    ['a payment two days later', '2026-09-02T18:36:00Z', '2026-09-03'],
  ])('is not annotated for %s', (_name, createdAt, businessDate) => {
    const out = runMatcher({
      ...emptyInput(),
      ledger: [l],
      payments: [after(createdAt, businessDate)],
    });
    expect(out.groups[0]?.reasonCode).toBeNull();
  });

  it('gives way to a refund explanation when there is one', () => {
    const out = runMatcher({
      ...emptyInput(),
      ledger: [l],
      payments: [after('2026-09-01T18:36:00Z', '2026-09-02')],
      refunds: [refund('rfnd_1', 'pay_1', 10)],
    });
    expect(out.groups[0]?.reasonCode).toBe('PARTIAL_REFUND_NETTED');
  });

  it('respects the configured window', () => {
    const out = runMatcher(
      { ...emptyInput(), ledger: [l], payments: [after('2026-09-01T18:36:00Z', '2026-09-02')] },
      matcherConfig({ dateShiftWindowMinutes: 5 }),
    );
    expect(out.groups[0]?.reasonCode).toBeNull();
  });
});

describe('T1: output does not depend on input order', () => {
  it('gives the same result for reversed input', () => {
    const lg = [ledger('ORD-1', 100), ledger('ORD-2', 200), ledger('ORD-3', 300)];
    const pm = [
      payment('pay_1', 'ORD-1', 100),
      payment('pay_2', 'ORD-2', 201),
      payment('pay_9', 'X', 5),
    ];
    const forward = runMatcher({ ...emptyInput(), ledger: lg, payments: pm });
    const backward = runMatcher({
      ...emptyInput(),
      ledger: [...lg].reverse(),
      payments: [...pm].reverse(),
    });
    expect(backward).toEqual(forward);
  });
});
