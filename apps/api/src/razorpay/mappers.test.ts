import {
  rzpPaymentSchema,
  rzpRefundSchema,
  rzpSettlementSchema,
  settlementItemSchema,
} from '@ziro/core/domain';
import {
  orderIngestSchema,
  paymentIngestSchema,
  reconItemIngestSchema,
  refundIngestSchema,
  settlementIngestSchema,
} from '@ziro/core/razorpay';
import { istDayBounds } from '@ziro/core/time';
import { describe, expect, it } from 'vitest';
import { parseEntries } from './entries.js';
import { MappingError, RazorpayResponseError } from './errors.js';
import { importHash } from './identity.js';
import {
  mapPayment,
  mapReconItem,
  mapRefund,
  mapSettlement,
  receiptsByOrderId,
  sortChronologically,
} from './mappers.js';
import { docsDerivedCollections, RUN_ID } from './razorpay.fixtures.js';

const ctx = { runId: RUN_ID, source: 'razorpay_testmode' } as const;
const docs = docsDerivedCollections();
const receipts = receiptsByOrderId(parseEntries(docs.orders, orderIngestSchema, 'orders'));
const payment = (id: string) => {
  const raw = docs.payments.find((p) => (p as { id: string }).id === id);
  const [entry] = parseEntries([raw], paymentIngestSchema, 'payment');
  if (!entry) throw new Error(`no fixture ${id}`);
  return entry;
};

describe('mapPayment', () => {
  it('maps a captured netbanking payment into a valid domain record', () => {
    const { record } = mapPayment(payment('pay_NetBank0000001'), receipts, ctx);
    expect(rzpPaymentSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      paymentId: 'pay_NetBank0000001',
      orderId: 'order_DBJOWzybf0sJbb',
      receipt: 'ORD-5001',
      amount: 2100n,
      fee: 50n,
      tax: 8n,
      amountRefunded: 0n,
      method: 'netbanking',
      status: 'captured',
      captured: true,
      source: 'razorpay_testmode',
      sourceRef: 'pay_NetBank0000001',
    });
  });

  it('keeps money as bigint paise, never a number', () => {
    const { record } = mapPayment(payment('pay_WalletRefund001'), receipts, ctx);
    for (const field of [record.amount, record.fee, record.tax, record.amountRefunded])
      expect(typeof field).toBe('bigint');
    expect(record).toMatchObject({
      amount: 250000n,
      fee: 5900n,
      tax: 900n,
      amountRefunded: 250000n,
      status: 'refunded',
    });
  });

  it('accepts a captured payment whose tax is 0, as in the docs', () => {
    expect(mapPayment(payment('pay_CardNoTax00001'), receipts, ctx).record).toMatchObject({
      fee: 100n,
      tax: 0n,
    });
  });

  it('maps an uncaptured payment with null fee and tax to 0: nothing was charged', () => {
    const { record } = mapPayment(payment('pay_Authorized0001'), receipts, ctx);
    expect(record).toMatchObject({
      fee: 0n,
      tax: 0n,
      captured: false,
      status: 'authorized',
      orderId: null,
      receipt: null,
    });
  });

  it('refuses a CAPTURED payment with no fee instead of silently zeroing it', () => {
    const raw = { ...(docs.payments[0] as object), fee: null, tax: null };
    const [entry] = parseEntries([raw], paymentIngestSchema, 'payment');
    expect(() => mapPayment(entry!, receipts, ctx)).toThrow(MappingError);
    expect(() => mapPayment(entry!, receipts, ctx)).toThrow(/captured but has no fee/);
  });

  it('leaves the receipt null when the order is unknown', () => {
    const { record } = mapPayment(payment('pay_NetBank0000001'), new Map(), ctx);
    expect(record.receipt).toBeNull();
  });

  it('refuses a non-integer amount rather than rounding it', () => {
    const raw = { ...(docs.payments[0] as object), amount: 2100.5 };
    expect(() => parseEntries([raw], paymentIngestSchema, 'payment')).toThrow(
      RazorpayResponseError,
    );
  });

  it('refuses a refund larger than the payment, which the domain forbids', () => {
    const raw = { ...(docs.payments[0] as object), amount_refunded: 999_999 };
    const [entry] = parseEntries([raw], paymentIngestSchema, 'payment');
    expect(() => mapPayment(entry!, receipts, ctx)).toThrow(/cannot refund more/);
  });

  it('keeps the original payload exactly as received, extras included, and hashes it', () => {
    const entry = payment('pay_NetBank0000001');
    const mapped = mapPayment(entry, receipts, ctx);
    expect(mapped.raw).toBe(entry.original);
    expect((mapped.raw as { amount_captured: number }).amount_captured).toBe(2100);
    expect(mapped.record.importHash).toBe(importHash(entry.original));
  });

  it('is deterministic: the same input gives the same id and hash', () => {
    const a = mapPayment(payment('pay_NetBank0000001'), receipts, ctx).record;
    const b = mapPayment(payment('pay_NetBank0000001'), receipts, ctx).record;
    expect(a).toEqual(b);
    expect(
      mapPayment(payment('pay_NetBank0000001'), receipts, {
        ...ctx,
        runId: '00000000-0000-4000-8000-0000000000bb',
      }).record.id,
    ).not.toBe(a.id);
  });

  describe('IST business dates', () => {
    const withCreatedAt = (created_at: number) => {
      const [entry] = parseEntries(
        [{ ...(docs.payments[0] as object), created_at }],
        paymentIngestSchema,
        'p',
      );
      return mapPayment(entry!, receipts, ctx).record;
    };
    const { fromEpoch } = istDayBounds('2026-10-08');

    it('puts the last second before IST midnight on the same day, the first after on the next', () => {
      expect(withCreatedAt(fromEpoch + 86_399).businessDate).toBe('2026-10-08');
      expect(withCreatedAt(fromEpoch + 86_400).businessDate).toBe('2026-10-09');
    });

    it('differs from the UTC date between 18:30 and 24:00 UTC (the TIMEZONE_DATE_SHIFT window)', () => {
      const utc1830 = Date.UTC(2026, 9, 8, 18, 30, 0) / 1000;
      const record = withCreatedAt(utc1830);
      expect(record.createdAt).toBe('2026-10-08T18:30:00Z');
      expect(record.businessDate).toBe('2026-10-09');
    });
  });
});

describe('mapRefund / mapSettlement / mapReconItem', () => {
  it('maps a refund', () => {
    const [entry] = parseEntries(docs.refunds, refundIngestSchema, 'refunds');
    const { record } = mapRefund(entry!, ctx);
    expect(rzpRefundSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      refundId: 'rfnd_DfjjhJC6eDvUAi',
      paymentId: 'pay_NetBank0000001',
      amount: 6000n,
      status: 'processed',
      businessDate: '2026-10-12',
    });
  });

  it('maps a settlement and keeps the UTR', () => {
    const [entry] = parseEntries(docs.settlements, settlementIngestSchema, 'settlements');
    const { record } = mapSettlement(entry!, ctx);
    expect(rzpSettlementSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      settlementId: 'setl_DGlQ1Rj8os78Ec',
      amount: 9973635n,
      fees: 0n,
      tax: 0n,
      utr: '1568176960vxp0rj',
      businessDate: '2026-10-12',
    });
  });

  it('maps all four recon line types with their documented arithmetic', () => {
    const lines = parseEntries(docs.recon, reconItemIngestSchema, 'recon').map(
      (e) => mapReconItem(e, ctx).record,
    );
    expect(lines.every((l) => settlementItemSchema.safeParse(l).success)).toBe(true);
    const by = Object.fromEntries(lines.map((l) => [l.itemType, l]));
    expect(by['payment']).toMatchObject({
      amount: 100000n,
      fee: 2900n,
      credit: 97100n,
      debit: 0n,
      paymentId: null,
    });
    expect(by['refund']).toMatchObject({
      amount: 242500n,
      debit: 242500n,
      credit: 0n,
      fee: 0n,
      paymentId: 'pay_EpkFDYRirena0f',
    });
    expect(by['transfer']).toMatchObject({ amount: 100000n, fee: 296n, tax: 46n, debit: 100296n });
    expect(by['adjustment']).toMatchObject({
      amount: 1012n,
      credit: 1012n,
      description: 'test reason',
    });
  });

  it('keys a recon line by settlement id and entity id', () => {
    const [entry] = parseEntries(docs.recon, reconItemIngestSchema, 'recon');
    expect(mapReconItem(entry!, ctx).record.sourceRef).toBe(
      'setl_DGlQ1Rj8os78Ec:pay_DEXrnipqTmWVGE',
    );
  });

  it('converts settled_at to an ISO instant', () => {
    const [entry] = parseEntries(docs.recon, reconItemIngestSchema, 'recon');
    expect(mapReconItem(entry!, ctx).record.settledAt).toBe('2026-10-12T02:00:00Z'); // 07:30 IST
  });

  it('treats an empty UTR as none', () => {
    const [entry] = parseEntries(
      [{ ...(docs.settlements[0] as object), utr: '' }],
      settlementIngestSchema,
      's',
    );
    expect(mapSettlement(entry!, ctx).record.utr).toBeNull();
  });
});

describe('receiptsByOrderId / sortChronologically', () => {
  it('treats a blank receipt as none', () => {
    const entries = parseEntries(
      [
        { id: 'order_A', receipt: '', created_at: 1 },
        { id: 'order_B', receipt: 'R1', created_at: 2 },
        { id: 'order_C', created_at: 3 },
      ],
      orderIngestSchema,
      'orders',
    );
    expect(receiptsByOrderId(entries)).toEqual(
      new Map([
        ['order_A', null],
        ['order_B', 'R1'],
        ['order_C', null],
      ]),
    );
  });

  it('sorts by time then by source reference, so any input order gives one output order', () => {
    const items = [
      { record: { sourceRef: 'b', t: '2026-01-02' }, raw: null },
      { record: { sourceRef: 'a', t: '2026-01-02' }, raw: null },
      { record: { sourceRef: 'z', t: '2026-01-01' }, raw: null },
    ];
    const sorted = sortChronologically(items, (r) => r.t).map((i) => i.record.sourceRef);
    expect(sorted).toEqual(['z', 'a', 'b']);
    expect(
      sortChronologically([...items].reverse(), (r) => r.t).map((i) => i.record.sourceRef),
    ).toEqual(sorted);
  });
});
