import { describe, expect, it } from 'vitest';
import type { TestPayment } from './api';
import {
  BANK_TEMPLATE,
  daysAgo,
  istDay,
  LEDGER_TEMPLATE,
  paidAt,
  parseRefund,
  rupeesText,
  shortId,
  statusView,
  summarize,
} from './test-account';

const payment = (over: Partial<TestPayment> = {}): TestPayment => ({
  paymentId: 'pay_AbCdEf1234567',
  orderId: 'order_1',
  receipt: 'ORD-1',
  method: 'upi',
  status: 'captured',
  captured: true,
  amountPaise: '50000',
  amountRefundedPaise: '0',
  refundablePaise: '50000',
  canRefund: true,
  cannotRefundBecause: null,
  createdAt: '2026-10-26T01:02:00+05:30',
  businessDate: '2026-10-26',
  ...over,
});

describe('days in India', () => {
  it('names the Indian calendar day, not the UTC one', () => {
    // 20:00 UTC on the 25th is already the 26th in India.
    expect(istDay(new Date('2026-10-25T20:00:00Z'))).toBe('2026-10-26');
    expect(istDay(new Date('2026-10-25T10:00:00Z'))).toBe('2026-10-25');
  });

  it('counts back whole days', () => {
    const now = new Date('2026-10-26T06:00:00Z');
    expect(daysAgo(0, now)).toBe('2026-10-26');
    expect(daysAgo(30, now)).toBe('2026-09-26');
  });
});

describe('statusView', () => {
  it.each([
    [{ status: 'captured', captured: true, amountRefundedPaise: '0' }, 'Captured', 'ok'],
    [{ status: 'authorized', captured: false, amountRefundedPaise: '0' }, 'Not captured', 'wait'],
    [{ status: 'failed', captured: false, amountRefundedPaise: '0' }, 'Failed', 'plain'],
    [{ status: 'created', captured: false, amountRefundedPaise: '0' }, 'Not paid', 'plain'],
    [{ status: 'refunded', captured: true, amountRefundedPaise: '50000' }, 'Refunded', 'info'],
    [
      { status: 'captured', captured: true, amountRefundedPaise: '2000' },
      'Partly refunded',
      'info',
    ],
    [
      { status: 'something_new', captured: false, amountRefundedPaise: '0' },
      'something_new',
      'plain',
    ],
  ])('%j reads as %s', (input, label, tone) => {
    expect(statusView(input)).toEqual({ label, tone });
  });
});

describe('summarize', () => {
  it('is all zeros for an empty account', () => {
    expect(summarize([])).toEqual({
      count: 0,
      captured: 0,
      notCaptured: 0,
      failed: 0,
      refunded: 0,
      capturedPaise: '0',
      refundedPaise: '0',
    });
  });

  it('adds money as integers and counts each state once', () => {
    const out = summarize([
      payment({ amountPaise: '50000' }),
      payment({ amountPaise: '12345', amountRefundedPaise: '2345' }),
      payment({ status: 'authorized', captured: false, amountPaise: '99900' }),
      payment({ status: 'failed', captured: false, amountPaise: '100' }),
      payment({ status: 'refunded', amountPaise: '1000', amountRefundedPaise: '1000' }),
    ]);
    expect(out).toEqual({
      count: 5,
      captured: 3,
      notCaptured: 1,
      failed: 1,
      refunded: 2,
      capturedPaise: '63345',
      refundedPaise: '3345',
    });
  });

  it('does not lose a paisa on a large amount', () => {
    expect(summarize([payment({ amountPaise: '9007199254740993' })]).capturedPaise).toBe(
      '9007199254740993',
    );
  });
});

describe('rupeesText', () => {
  it.each([
    ['50000', '500.00'],
    ['100', '1.00'],
    ['5', '0.05'],
    ['123456', '1234.56'],
  ])('%s paise is %s', (paise, text) => {
    expect(rupeesText(paise)).toBe(text);
  });
});

describe('parseRefund', () => {
  const p = { refundablePaise: '30000' };

  it('accepts a whole or part refund up to what is left, in paise', () => {
    expect(parseRefund('300', p)).toEqual({ ok: true, paise: 30_000 });
    expect(parseRefund('1', p)).toEqual({ ok: true, paise: 100 });
    expect(parseRefund('12.5', p)).toEqual({ ok: true, paise: 1_250 });
    expect(parseRefund('299.99', p)).toEqual({ ok: true, paise: 29_999 });
  });

  it('says what is wrong, in words', () => {
    expect(parseRefund('', p)).toEqual({ ok: false, why: 'Enter an amount.' });
    expect(parseRefund('abc', p)).toMatchObject({ ok: false });
    expect(parseRefund('0.50', p)).toEqual({
      ok: false,
      why: 'Enter an amount from ₹1, with at most two decimals.',
    });
    expect(parseRefund('1.234', p)).toMatchObject({ ok: false });
    expect(parseRefund('-5', p)).toMatchObject({ ok: false });
    expect(parseRefund('300.01', p)).toEqual({ ok: false, why: 'Only ₹300.00 is left to refund.' });
  });
});

describe('small formatters', () => {
  it('shortens a payment id but leaves a short one alone', () => {
    expect(shortId('pay_TsGWlb6nrKhVOv')).toBe('pay_TsGW…hVOv');
    expect(shortId('pay_short')).toBe('pay_short');
  });

  it('writes a payment time in India time, and gives back what it cannot read', () => {
    expect(paidAt('2026-10-25T20:30:00Z')).toMatch(/26 Oct/);
    expect(paidAt('not a time')).toBe('not a time');
  });
});

describe('the CSV templates', () => {
  it('carry the headers the importers require, in order', () => {
    expect(LEDGER_TEMPLATE.split('\r\n')[0]).toBe('order_ref,order_date,amount,customer_ref,memo');
    expect(BANK_TEMPLATE.split('\r\n')[0]).toBe('value_date,narration,debit,credit,balance');
  });
});
