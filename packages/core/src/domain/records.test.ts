import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  bankLineSchema,
  ledgerEntrySchema,
  rzpPaymentSchema,
  rzpRefundSchema,
  rzpSettlementSchema,
  settlementItemSchema,
} from './index.js';
import {
  bankLineFixture,
  HASH,
  ledgerEntryFixture,
  rzpPaymentFixture,
  rzpRefundFixture,
  rzpSettlementFixture,
  settlementItemFixture,
} from './domain.fixtures.js';

/** Paths of the issues a schema reports, with unknown keys reported as "(unknown key)". */
function failures(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) =>
    i.code === 'unrecognized_keys' ? '(unknown key)' : i.path.join('.'),
  );
}

type Fixture = Record<string, unknown>;
const mutate = (base: Fixture, patch: Fixture): Fixture => ({ ...base, ...patch });

describe('LedgerEntry', () => {
  it('parses a valid entry and turns the amount into a bigint', () => {
    const entry = ledgerEntrySchema.parse(ledgerEntryFixture());
    expect(entry.amount).toBe(250000n);
    expect(entry.businessDate).toBe('2026-10-21');
  });

  it('rejects float, negative and malformed money', () => {
    for (const amount of [2500.5, '2500.50', -1, '-1', '1e3']) {
      expect(
        failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { amount })),
        String(amount),
      ).toEqual(['amount']);
    }
  });

  it('rejects unknown keys, bad dates, empty refs and oversized memos', () => {
    expect(failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { extra: 1 }))).toEqual([
      '(unknown key)',
    ]);
    expect(
      failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { businessDate: '2026-02-30' })),
    ).toEqual(['businessDate']);
    expect(failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { orderRef: '' }))).toEqual([
      'orderRef',
    ]);
    expect(
      failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { memo: 'x'.repeat(2001) })),
    ).toEqual(['memo']);
  });

  it('rejects a bad source, run id or import hash', () => {
    expect(
      failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { source: 'razorpay_live' })),
    ).toEqual(['source']);
    expect(
      failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { runId: 'not-a-uuid' })),
    ).toEqual(['runId']);
    expect(
      failures(ledgerEntrySchema, mutate(ledgerEntryFixture(), { importHash: HASH.toUpperCase() })),
    ).toEqual(['importHash']);
  });
});

describe('RzpPayment', () => {
  it('parses Razorpay-style input: JSON integers, bigint, strings', () => {
    const payment = rzpPaymentSchema.parse(rzpPaymentFixture());
    expect(payment).toMatchObject({ amount: 250000n, fee: 5900n, tax: 900n, amountRefunded: 0n });
  });

  it('keeps fee GST-inclusive: tax may not exceed fee, but need not equal 18%', () => {
    expect(failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { fee: 100, tax: 101 }))).toEqual(
      ['tax'],
    );
    // Razorpay documents samples with a fee and tax 0; the schema must not reject them.
    expect(failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { fee: 100, tax: 0 }))).toEqual(
      [],
    );
  });

  it('cannot be refunded for more than it was', () => {
    expect(
      failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { amountRefunded: 250001 })),
    ).toEqual(['amountRefunded']);
    expect(
      failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { amountRefunded: 250000 })),
    ).toEqual([]);
  });

  it('allows a payment without an order, and rejects a malformed id or unknown status', () => {
    expect(
      failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { orderId: null, receipt: null })),
    ).toEqual([]);
    expect(
      failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { paymentId: 'rfnd_1' })),
    ).toEqual(['paymentId']);
    expect(failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { status: 'settled' }))).toEqual([
      'status',
    ]);
  });

  it('rejects float money from a careless producer', () => {
    expect(failures(rzpPaymentSchema, mutate(rzpPaymentFixture(), { fee: 59.0001 }))).toEqual([
      'fee',
    ]);
  });
});

describe('RzpRefund', () => {
  it('parses a valid refund', () => {
    expect(rzpRefundSchema.parse(rzpRefundFixture()).amount).toBe(50000n);
  });

  it('rejects a refund pointing at a non-payment id', () => {
    expect(failures(rzpRefundSchema, mutate(rzpRefundFixture(), { paymentId: 'order_1' }))).toEqual(
      ['paymentId'],
    );
  });
});

describe('RzpSettlement', () => {
  it('parses a valid settlement with a large net amount', () => {
    expect(rzpSettlementSchema.parse(rzpSettlementFixture()).amount).toBe(9973635n);
  });

  it('allows a missing UTR but rejects an unknown status', () => {
    expect(failures(rzpSettlementSchema, mutate(rzpSettlementFixture(), { utr: null }))).toEqual(
      [],
    );
    expect(
      failures(rzpSettlementSchema, mutate(rzpSettlementFixture(), { status: 'done' })),
    ).toEqual(['status']);
  });
});

describe('SettlementItem', () => {
  it('parses a payment line', () => {
    expect(settlementItemSchema.parse(settlementItemFixture())).toMatchObject({
      itemType: 'payment',
      credit: 244100n,
      debit: 0n,
    });
  });

  it('accepts the four documented types and rejects others', () => {
    for (const itemType of ['payment', 'refund', 'transfer', 'adjustment']) {
      expect(
        failures(settlementItemSchema, mutate(settlementItemFixture(), { itemType })),
        itemType,
      ).toEqual([]);
    }
    expect(
      failures(settlementItemSchema, mutate(settlementItemFixture(), { itemType: 'dispute' })),
    ).toEqual(['itemType']);
  });

  it('allows adjustments that belong to no payment', () => {
    const adjustment = mutate(settlementItemFixture(), {
      itemType: 'adjustment',
      entityId: 'adj_123',
      paymentId: null,
      orderId: null,
      credit: 0,
      debit: 12000,
    });
    expect(failures(settlementItemSchema, adjustment)).toEqual([]);
  });
});

describe('BankLine', () => {
  it('parses a credit line with its balance', () => {
    expect(bankLineSchema.parse(bankLineFixture())).toMatchObject({
      amount: 9973635n,
      balance: 1234567800n,
    });
  });

  it('allows a negative running balance (overdraft) but not a negative amount', () => {
    expect(failures(bankLineSchema, mutate(bankLineFixture(), { balance: '-500' }))).toEqual([]);
    expect(failures(bankLineSchema, mutate(bankLineFixture(), { amount: '-500' }))).toEqual([
      'amount',
    ]);
  });

  it('allows missing UTR and balance, and rejects an unknown direction', () => {
    expect(
      failures(bankLineSchema, mutate(bankLineFixture(), { utr: null, balance: null })),
    ).toEqual([]);
    expect(failures(bankLineSchema, mutate(bankLineFixture(), { direction: 'cr' }))).toEqual([
      'direction',
    ]);
  });
});
