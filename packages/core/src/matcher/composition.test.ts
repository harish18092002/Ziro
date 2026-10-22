import { describe, expect, it } from 'vitest';
import { paise } from '../money/index.js';
import { composeLines, composeSettlement, isVerified, itemPaymentId } from './composition.js';
import { payment, refund, settlementOf } from './matcher.fixtures.js';

const P = (n: number) => paise(BigInt(n));
const pay1 = payment('pay_1', 'ORD-1', 100_000, { fee: P(2360), tax: P(360) });
const pay2 = payment('pay_2', 'ORD-2', 50_000, { fee: P(1180), tax: P(180) });
const rfnd1 = refund('rfnd_1', 'pay_1', 20_000);

const lookups = (payments = [pay1, pay2], refunds = [rfnd1]) => ({
  payment: (id: string) => payments.find((p) => p.paymentId === id),
  refund: (id: string) => refunds.find((r) => r.refundId === id),
});

// (100000 − 2360) + (50000 − 1180) − 20000 − 5000 = 97640 + 48820 − 25000 = 121460
const full = settlementOf('setl_1', '2026-09-04', {
  payments: [pay1, pay2],
  refunds: [rfnd1],
  adjustments: [{ id: 'adj_1', debit: 5000, description: 'Chargeback: dispute disp_1 on pay_2' }],
});

describe('composeSettlement', () => {
  it('breaks a settlement into payments, fees, refunds and adjustments, and balances to the paise', () => {
    const c = composeSettlement(full.settlement, full.items, lookups());
    expect(c).toMatchObject({
      settlementId: 'setl_1',
      settlementAmount: 121_460n,
      gross: 150_000n,
      fees: 3540n,
      tax: 540n,
      refunds: 20_000n,
      adjustmentsCredit: 0n,
      adjustmentsDebit: 5000n,
      computed: 121_460n,
      residual: 0n,
      paymentLines: 2,
      refundLines: 1,
      adjustmentLines: 1,
      paymentIds: ['pay_1', 'pay_2'],
      issues: [],
    });
    expect(isVerified(c)).toBe(true);
  });

  it('does not subtract the GST a second time: the fee already includes it (ADR-004)', () => {
    const c = composeSettlement(full.settlement, full.items, lookups());
    const wrong = c.gross - c.fees - c.tax - c.refunds - c.adjustmentsDebit; // 120920
    expect(wrong).toBe(120_920n);
    expect(c.computed).not.toBe(wrong);
    expect(c.residual).toBe(0n);
  });

  it('counts an adjustment credit as money in', () => {
    const credited = settlementOf('setl_2', '2026-09-04', {
      payments: [pay1],
      adjustments: [{ id: 'adj_c', credit: 3000 }],
    });
    // (100000 − 2360) + 3000 = 100640
    const c = composeSettlement(credited.settlement, credited.items, lookups());
    expect(c).toMatchObject({ computed: 100_640n, adjustmentsCredit: 3000n, residual: 0n });
  });

  it.each([1, -1, 100, -6800])('reports a settlement that is %i paise off, signed', (off) => {
    const wrong = { ...full.settlement, amount: P(121_460 + off) };
    const c = composeSettlement(wrong, full.items, lookups());
    expect(c.residual).toBe(BigInt(off));
    expect(isVerified(c)).toBe(false);
  });

  it('is unbalanced for a settlement with no lines at all', () => {
    const empty = settlementOf('setl_3', '2026-09-04', {});
    const c = composeSettlement({ ...empty.settlement, amount: P(5000) }, [], lookups());
    expect(c).toMatchObject({ computed: 0n, residual: 5000n });
    expect(isVerified(c)).toBe(false);
  });
});

describe('composeSettlement: cross-checks against the records', () => {
  it('blocks a line whose own credit is not amount − fee, even if the total still adds up', () => {
    const items = full.items.map((item) =>
      item.entityId === 'pay_1' ? { ...item, credit: P(97_641) } : item,
    );
    const c = composeSettlement(full.settlement, items, lookups());
    expect(c.residual).toBe(0n);
    expect(c.issues).toMatchObject([
      { severity: 'blocking', code: 'line_inconsistent', entityId: 'pay_1' },
    ]);
    expect(isVerified(c)).toBe(false);
  });

  it('blocks a payment line that disagrees with the payment record', () => {
    const records = lookups([{ ...pay1, fee: P(2361) }, pay2]);
    const c = composeSettlement(full.settlement, full.items, records);
    expect(c.issues).toMatchObject([{ severity: 'blocking', code: 'line_disagrees_with_payment' }]);
    expect(isVerified(c)).toBe(false);
  });

  it('blocks a payment line whose amount differs from the payment record, even with fee and tax equal', () => {
    const records = lookups([{ ...pay1, amount: P(100_001) }, pay2]);
    const c = composeSettlement(full.settlement, full.items, records);
    expect(c.issues).toMatchObject([
      { severity: 'blocking', code: 'line_disagrees_with_payment', entityId: 'pay_1' },
    ]);
  });

  it('blocks a refund line that does not debit exactly its amount', () => {
    const items = full.items.map((item) =>
      item.itemType === 'refund' ? { ...item, debit: P(19_999) } : item,
    );
    const c = composeSettlement(full.settlement, items, lookups());
    expect(c.issues).toMatchObject([
      { severity: 'blocking', code: 'line_inconsistent', entityId: 'rfnd_1' },
    ]);
    expect(isVerified(c)).toBe(false);
  });

  it('blocks a refund line that disagrees with the refund record', () => {
    const records = lookups([pay1, pay2], [{ ...rfnd1, amount: P(19_999) }]);
    const c = composeSettlement(full.settlement, full.items, records);
    expect(c.issues).toMatchObject([{ severity: 'blocking', code: 'line_disagrees_with_refund' }]);
  });

  it('only notes a line whose record is not in the data, as with a payment from before the period', () => {
    const c = composeSettlement(full.settlement, full.items, lookups([pay2], []));
    expect(c.issues.map((i) => [i.severity, i.code, i.entityId])).toEqual([
      ['note', 'payment_record_missing', 'pay_1'],
      ['note', 'refund_record_missing', 'rfnd_1'],
    ]);
    expect(isVerified(c)).toBe(true);
  });

  it('blocks a payment that appears twice in one settlement, and counts it once', () => {
    const copy = { ...(full.items[0] as (typeof full.items)[number]), id: 'dup', sourceRef: 'dup' };
    const c = composeSettlement(full.settlement, [...full.items, copy], lookups());
    expect(c.paymentLines).toBe(2);
    expect(c.issues.map((i) => i.code)).toEqual(['duplicate_line']);
    expect(isVerified(c)).toBe(false);
  });

  it('does not depend on the order of the lines', () => {
    const forward = composeSettlement(full.settlement, full.items, lookups());
    const backward = composeSettlement(full.settlement, [...full.items].reverse(), lookups());
    expect(backward).toEqual(forward);
  });
});

describe('itemPaymentId', () => {
  it('uses the entity id for a payment line and payment_id for a refund line', () => {
    const [payLine, , refundLine, adjustment] = [
      ...full.items.filter((i) => i.itemType === 'payment'),
      ...full.items.filter((i) => i.itemType === 'refund'),
      ...full.items.filter((i) => i.itemType === 'adjustment'),
    ];
    expect(itemPaymentId(payLine as (typeof full.items)[number])).toBe('pay_1');
    expect(itemPaymentId(refundLine as (typeof full.items)[number])).toBe('pay_1');
    expect(itemPaymentId(adjustment as (typeof full.items)[number])).toBeNull();
  });
});

describe('composeLines: the same arithmetic, with no settlement attached', () => {
  it('adds up arbitrary lines exactly as composeSettlement does', () => {
    const lines = composeLines(full.items, lookups());
    const settlement = composeSettlement(full.settlement, full.items, lookups());
    const {
      settlementId: _id,
      settlementAmount: _amount,
      residual: _residual,
      ...rest
    } = settlement;
    expect(lines).toEqual(rest);
    expect(lines.computed).toBe(121_460n);
  });

  it('works on hand-built lines and needs only the fields it reads', () => {
    const lines = composeLines(
      [
        {
          sourceRef: 'x',
          itemType: 'payment',
          entityId: 'pay_9',
          paymentId: null,
          amount: P(10_000),
          fee: P(236),
          tax: P(36),
          debit: P(0),
          credit: P(9764),
        },
      ],
      { payment: () => undefined, refund: () => undefined },
    );
    expect(lines).toMatchObject({ gross: 10_000n, fees: 236n, tax: 36n, computed: 9764n });
    expect(lines.issues.map((i) => i.code)).toEqual(['payment_record_missing']);
  });
});
