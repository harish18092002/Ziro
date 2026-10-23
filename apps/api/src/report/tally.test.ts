import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adjustmentVoucher,
  DEFAULT_LEDGER_NAMES,
  LINE_HEADER,
  lineRows,
  ledgerNamesOf,
  PAIR_HEADER,
  pairRows,
  type SettlementBooking,
  settlementVouchers,
  type Voucher,
} from './tally.js';

const N = DEFAULT_LEDGER_NAMES;

// Gross of the settled payments 100,040 paise = net 90,000 + fees 3,540 (GST 540 inside) + refunds 2,000
// + chargeback 4,000 + another debit adjustment 500.
const booking = (over: Partial<SettlementBooking> = {}): SettlementBooking => ({
  rzpId: 'setl_X1',
  utr: 'UTIB0000123',
  bankRef: 'row-11',
  bankDate: '2026-04-10',
  netPaise: 90_000n,
  feesPaise: 3_540n,
  gstPaise: 540n,
  refundsPaise: 2_000n,
  chargebackPaise: 4_000n,
  otherDebitPaise: 500n,
  creditAdjustmentsPaise: 0n,
  paymentIds: ['pay_a', 'pay_b', 'pay_c'],
  refundIds: ['rfnd_a'],
  adjustmentIds: ['adj_a', 'adj_b'],
  ...over,
});

const sum = (legs: readonly { paise: bigint }[]) => legs.reduce((n, l) => n + l.paise, 0n);
const clearingNet = (vs: readonly Voucher[]) =>
  vs.reduce(
    (n, v) =>
      n +
      sum(v.credits.filter((l) => l.ledger === N.RAZORPAY_CLEARING)) -
      sum(v.debits.filter((l) => l.ledger === N.RAZORPAY_CLEARING)),
    0n,
  );

describe('settlementVouchers', () => {
  it('books the money that landed as a Receipt and everything netted off as a Journal', () => {
    const [receipt, journal] = settlementVouchers(booking(), N);
    expect(receipt).toMatchObject({
      type: 'Receipt',
      no: 'ZIRO-setl_X1-R',
      date: '2026-04-10',
      debits: [{ ledger: N.BANK, paise: 90_000n }],
      credits: [{ ledger: N.RAZORPAY_CLEARING, paise: 90_000n }],
    });
    expect(journal?.type).toBe('Journal');
    expect(journal?.debits).toEqual([
      { ledger: N.PAYMENT_GATEWAY_FEES, paise: 3_000n },
      { ledger: N.GST_INPUT_CREDIT, paise: 540n },
      { ledger: N.REFUNDS, paise: 2_000n },
      { ledger: N.CHARGEBACK_LOSS, paise: 4_000n },
      { ledger: N.SUSPENSE, paise: 500n },
    ]);
    expect(journal?.credits).toEqual([{ ledger: N.RAZORPAY_CLEARING, paise: 10_040n }]);
  });

  it('credits Razorpay Clearing by exactly the gross of the settled payments', () => {
    expect(clearingNet(settlementVouchers(booking(), N))).toBe(100_040n);
  });

  it('splits the fee into base and GST: the GST is inside the fee, never added on top', () => {
    const [, journal] = settlementVouchers(booking(), N);
    const fee = journal?.debits.find((l) => l.ledger === N.PAYMENT_GATEWAY_FEES)?.paise ?? 0n;
    const gst = journal?.debits.find((l) => l.ledger === N.GST_INPUT_CREDIT)?.paise ?? 0n;
    expect(fee + gst).toBe(3_540n);
  });

  it('handles credit adjustments: they offset the clearing credit and are booked to suspense', () => {
    const vs = settlementVouchers(booking({ netPaise: 90_700n, creditAdjustmentsPaise: 700n }), N);
    const journal = vs[1];
    expect(journal?.credits).toContainEqual({ ledger: N.SUSPENSE, paise: 700n });
    expect(sum(journal?.debits ?? [])).toBe(sum(journal?.credits ?? []));
    // gross = net + fees + refunds + chargeback + other debit - credit adjustments
    expect(clearingNet(vs)).toBe(90_700n + 3_540n + 2_000n + 4_000n + 500n - 700n);
  });

  it('makes only a Receipt when there is nothing to net off', () => {
    const vs = settlementVouchers(
      booking({
        feesPaise: 0n,
        gstPaise: 0n,
        refundsPaise: 0n,
        chargebackPaise: 0n,
        otherDebitPaise: 0n,
        paymentIds: ['pay_a'],
        refundIds: [],
        adjustmentIds: [],
      }),
      N,
    );
    expect(vs.map((v) => v.type)).toEqual(['Receipt']);
  });

  it('puts the record ids in the voucher and a few of them in the narration', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `pay_${i}`);
    const [receipt, journal] = settlementVouchers(booking({ paymentIds: ids }), N);
    expect(receipt?.recordIds).toEqual(expect.arrayContaining(['setl_X1', 'bank:row-11', ...ids]));
    expect(journal?.narration).toContain('pay_0, pay_1, pay_2, pay_3 +5 more');
    expect(journal?.narration).toContain('setl_X1');
    expect(receipt?.narration).toContain('UTR UTIB0000123');
  });

  it('keeps a narration within its limit however many ids and however long they are', () => {
    const long = Array.from({ length: 6 }, (_, i) => `pay_${'x'.repeat(80)}${i}`);
    for (const v of settlementVouchers(booking({ paymentIds: long, refundIds: long }), N)) {
      expect(v.narration.length).toBeLessThanOrEqual(250);
    }
  });

  it('always balances, and always returns the whole gross to the clearing ledger (property)', () => {
    const amount = fc.bigInt({ min: 0n, max: 10_000_000n });
    fc.assert(
      fc.property(
        fc.record({
          net: fc.bigInt({ min: 1n, max: 10_000_000n }),
          fees: amount,
          gstShare: fc.bigInt({ min: 0n, max: 100n }),
          refunds: amount,
          chargeback: amount,
          other: amount,
          credit: amount,
        }),
        (r) => {
          const gst = (r.fees * r.gstShare) / 100n;
          const vs = settlementVouchers(
            booking({
              netPaise: r.net,
              feesPaise: r.fees,
              gstPaise: gst,
              refundsPaise: r.refunds,
              chargebackPaise: r.chargeback,
              otherDebitPaise: r.other,
              creditAdjustmentsPaise: r.credit,
            }),
            N,
          );
          for (const v of vs) expect(sum(v.debits)).toBe(sum(v.credits));
          expect(clearingNet(vs)).toBe(
            r.net + r.fees + r.refunds + r.chargeback + r.other - r.credit,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('adjustmentVoucher', () => {
  const draft = {
    proposalId: '91ff41f3-e9d3-46c7-afed-97d8c768bc1f',
    exceptionId: 'ex-1',
    about: 'pay_Z9',
    reviewer: 'a visitor',
    date: '2026-04-22',
    entry: {
      memo: 'Record the sale behind payment pay_Z9',
      lines: [
        { account: 'RAZORPAY_CLEARING' as const, debit: '250000', credit: '0' },
        { account: 'SALES' as const, debit: '0', credit: '250000' },
      ],
    },
  };

  it('books an approved draft as a Journal on the approval date, naming who approved it', () => {
    const v = adjustmentVoucher(draft, N);
    expect(v).toMatchObject({
      type: 'Journal',
      no: 'ZIRO-ADJ-91ff41f3',
      date: '2026-04-22',
      source: 'agent adjustment',
      debits: [{ ledger: N.RAZORPAY_CLEARING, paise: 250_000n }],
      credits: [{ ledger: N.SALES, paise: 250_000n }],
    });
    expect(v.narration).toContain('approved by a visitor');
  });

  it('refuses a draft that does not balance, rather than writing it', () => {
    const bad = {
      ...draft,
      entry: {
        ...draft.entry,
        lines: [
          { account: 'SUSPENSE' as const, debit: '100', credit: '0' },
          { account: 'SALES' as const, debit: '0', credit: '99' },
        ],
      },
    };
    expect(() => adjustmentVoucher(bad, N)).toThrow(/does not balance/);
  });
});

describe('ledger names', () => {
  it('uses the defaults, lets a run rename some, and ignores an invalid override', () => {
    expect(ledgerNamesOf(undefined)).toEqual(N);
    expect(ledgerNamesOf({ ledgerNames: { BANK: 'HDFC Current A/c' } }).BANK).toBe(
      'HDFC Current A/c',
    );
    expect(ledgerNamesOf({ ledgerNames: { BANK: '' } })).toEqual(N);
    expect(ledgerNamesOf({ ledgerNames: { NOT_AN_ACCOUNT: 'x' } })).toEqual(N);
  });
});

describe('CSV rows', () => {
  const [, journal] = settlementVouchers(booking(), N);

  it('pair rows: one debit/credit pair per row, together adding up to the voucher', () => {
    const rows = pairRows(journal as Voucher);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toHaveLength(PAIR_HEADER.length);
      expect(row[2]).toBe('ZIRO-setl_X1-J');
      expect(row[4]).toBe(N.RAZORPAY_CLEARING);
    }
    expect(rows.map((r) => r[5])).toEqual(['30.00', '5.40', '20.00', '40.00', '5.00']);
    expect(rows[0]?.[0]).toBe('2026-04-10');
  });

  it('pair rows split a many-to-many voucher without losing a paisa', () => {
    const v: Voucher = {
      ...(journal as Voucher),
      debits: [
        { ledger: 'A', paise: 70n },
        { ledger: 'B', paise: 30n },
      ],
      credits: [
        { ledger: 'X', paise: 60n },
        { ledger: 'Y', paise: 40n },
      ],
    };
    const rows = pairRows(v);
    expect(rows.map((r) => [r[3], r[4], r[5]])).toEqual([
      ['A', 'X', '0.60'],
      ['A', 'Y', '0.10'],
      ['B', 'Y', '0.30'],
    ]);
  });

  it('line rows: every ledger line once, debits then credits, in the layout Tally maps', () => {
    const rows = lineRows(journal as Voucher);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.length === LINE_HEADER.length)).toBe(true);
    expect(rows.map((r) => r[4])).toEqual(['Dr', 'Dr', 'Dr', 'Dr', 'Dr', 'Cr']);
    const dr = rows.filter((r) => r[4] === 'Dr').reduce((n, r) => n + Number(r[5]), 0);
    const cr = rows.filter((r) => r[4] === 'Cr').reduce((n, r) => n + Number(r[5]), 0);
    expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
    expect(rows[0]?.slice(0, 3)).toEqual(['ZIRO-setl_X1-J', '2026-04-10', 'Journal']);
  });
});
