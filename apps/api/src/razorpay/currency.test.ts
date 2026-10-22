// Currency is read as Razorpay states it. A foreign-currency record is not rejected at the door (that
// would hide it) and not treated as rupees (that would corrupt the books); it is stored faithfully and
// the verifier refuses to match it.
import {
  paymentIngestSchema,
  reconItemIngestSchema,
  refundIngestSchema,
} from '@ziro/core/razorpay';
import { describe, expect, it } from 'vitest';
import { parseEntries } from './entries.js';
import { mapPayment, mapReconItem, mapRefund } from './mappers.js';
import { docsDerivedCollections, RUN_ID } from './razorpay.fixtures.js';

const ctx = { runId: RUN_ID, source: 'razorpay_testmode' } as const;
const docs = docsDerivedCollections();
const receipts = new Map<string, string | null>();

function firstOf(list: readonly unknown[]): Record<string, unknown> {
  const [first] = list;
  if (typeof first !== 'object' || first === null) throw new Error('empty fixture');
  return first as Record<string, unknown>;
}

describe('currency', () => {
  it('is carried on a payment, a refund and a recon line', () => {
    const rawPayment = { ...firstOf(docs.payments), currency: 'USD' };
    const [payment] = parseEntries([rawPayment], paymentIngestSchema, 'payment');
    expect(payment).toBeDefined();
    expect(mapPayment(payment!, receipts, ctx).record.currency).toBe('USD');

    const rawRefund = { ...firstOf(docs.refunds), currency: 'EUR' };
    const [refund] = parseEntries([rawRefund], refundIngestSchema, 'refund');
    expect(mapRefund(refund!, ctx).record.currency).toBe('EUR');

    const rawLine = { ...firstOf(docs.recon), currency: 'GBP' };
    const [line] = parseEntries([rawLine], reconItemIngestSchema, 'recon');
    expect(mapReconItem(line!, ctx).record.currency).toBe('GBP');
  });

  it('is INR when Razorpay says INR, and when it says nothing', () => {
    const raw = { ...firstOf(docs.payments) };
    delete raw['currency'];
    const [payment] = parseEntries([raw], paymentIngestSchema, 'payment');
    expect(mapPayment(payment!, receipts, ctx).record.currency).toBe('INR');
    const [stated] = parseEntries([{ ...raw, currency: 'INR' }], paymentIngestSchema, 'payment');
    expect(mapPayment(stated!, receipts, ctx).record.currency).toBe('INR');
  });

  it('refuses a currency that is not a three-letter code', () => {
    for (const bad of ['inr', 'RS', 'RUPEES', '']) {
      const raw = { ...firstOf(docs.payments), currency: bad };
      expect(() => parseEntries([raw], paymentIngestSchema, 'payment'), bad).toThrow();
    }
  });
});
