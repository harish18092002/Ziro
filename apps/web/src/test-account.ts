// What the test-account page does with its data, apart from the page: tested on its own. Money stays integer
// paise (bigint or digit strings); nothing here uses a float for an amount.
import type { TestPayment } from './api';
import { inr } from './format';
import { rupeesToPaise } from './pay-math';

/** A calendar day in India as YYYY-MM-DD: the day Ziro's business dates use. */
export const istDay = (when: Date): string =>
  when.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export const daysAgo = (days: number, now: Date = new Date()): string =>
  istDay(new Date(now.getTime() - days * 86_400_000));

export type Tone = 'ok' | 'wait' | 'info' | 'plain';

/** How a payment is labelled: Razorpay's status, in the words a merchant uses. */
export function statusView(p: Pick<TestPayment, 'status' | 'captured' | 'amountRefundedPaise'>): {
  label: string;
  tone: Tone;
} {
  if (p.status === 'refunded') return { label: 'Refunded', tone: 'info' };
  if (p.amountRefundedPaise !== '0') return { label: 'Partly refunded', tone: 'info' };
  if (p.captured && p.status === 'captured') return { label: 'Captured', tone: 'ok' };
  if (p.status === 'authorized') return { label: 'Not captured', tone: 'wait' };
  if (p.status === 'failed') return { label: 'Failed', tone: 'plain' };
  if (p.status === 'created') return { label: 'Not paid', tone: 'plain' };
  return { label: p.status, tone: 'plain' };
}

export interface PaymentsSummary {
  readonly count: number;
  readonly captured: number;
  readonly notCaptured: number;
  readonly failed: number;
  readonly refunded: number;
  /** Paise as text: what was captured, and what of it has gone back. */
  readonly capturedPaise: string;
  readonly refundedPaise: string;
}

export function summarize(payments: readonly TestPayment[]): PaymentsSummary {
  let captured = 0;
  let notCaptured = 0;
  let failed = 0;
  let refunded = 0;
  let capturedPaise = 0n;
  let refundedPaise = 0n;
  for (const p of payments) {
    if (p.status === 'failed') failed += 1;
    else if (p.status === 'authorized') notCaptured += 1;
    if (p.captured || p.status === 'refunded') {
      captured += 1;
      capturedPaise += BigInt(p.amountPaise);
    }
    if (p.amountRefundedPaise !== '0') {
      refunded += 1;
      refundedPaise += BigInt(p.amountRefundedPaise);
    }
  }
  return {
    count: payments.length,
    captured,
    notCaptured,
    failed,
    refunded,
    capturedPaise: capturedPaise.toString(),
    refundedPaise: refundedPaise.toString(),
  };
}

/** 50000 paise as "500.00": the text a refund box starts with. Not grouped, so it can be typed back. */
export function rupeesText(paiseText: string): string {
  const value = BigInt(paiseText);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export type RefundInput = { ok: true; paise: number } | { ok: false; why: string };

/** What someone typed into the refund box, checked against what can still be refunded. */
export function parseRefund(text: string, p: Pick<TestPayment, 'refundablePaise'>): RefundInput {
  if (text.trim() === '') return { ok: false, why: 'Enter an amount.' };
  const paise = rupeesToPaise(text);
  if (paise === null) {
    return { ok: false, why: 'Enter an amount from ₹1, with at most two decimals.' };
  }
  if (BigInt(paise) > BigInt(p.refundablePaise)) {
    return { ok: false, why: `Only ${inr(p.refundablePaise)} is left to refund.` };
  }
  return { ok: true, paise };
}

/** `pay_TsGWlb6nrKhVOv` as `pay_TsGW…hVOv`: enough to recognise, short enough for a table. */
export const shortId = (id: string): string =>
  id.length > 15 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;

/** When a payment was made, in India time: "26 Oct, 1:02 am". */
export function paidAt(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The CSV a person can fill in: the header Ziro reads, and one example row they should replace. */
export const LEDGER_TEMPLATE =
  'order_ref,order_date,amount,customer_ref,memo\r\nORD-100001,26-10-2026,500.00,CUST-1,Replace this example row\r\n';
export const BANK_TEMPLATE =
  'value_date,narration,debit,credit,balance\r\n26/10/2026,NEFT CR RAZORPAY SETTLEMENT,,500.00,500.00\r\n';
