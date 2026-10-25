import {
  BadGatewayException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RzpPayment } from '@ziro/core/domain';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import { REFUND_NO_REASON } from './explain.js';
import {
  generateReceipt,
  RazorpayController,
  testOrderSchema,
  testPaymentsQuery,
  testRefundSchema,
} from './razorpay.controller.js';
import type { RazorpaySourceFactory } from './razorpay.factory.js';
import type { RazorpayWriter } from './sdk-client.js';
import type { FetchResult, RazorpaySource } from './source.js';

const KEY_ID = 'rzp_test_AbCdEf123456';

function controller(
  writer: Partial<RazorpayWriter> | null,
  over: { demo?: boolean; ready?: boolean; account?: Partial<RazorpaySource> } = {},
) {
  const factory = {
    status: () => ({
      source: over.ready === false ? 'synthetic' : 'testmode',
      ready: over.ready !== false,
      keyId: over.ready === false ? null : KEY_ID,
    }),
    writer: () => {
      if (writer === null) throw new RazorpayConfigError('Razorpay test mode is off');
      return writer as RazorpayWriter;
    },
    account: () => {
      if (over.account === undefined) throw new RazorpayConfigError('Razorpay test mode is off');
      return over.account as RazorpaySource;
    },
  } as unknown as RazorpaySourceFactory;
  return new RazorpayController(factory, { DEMO_MODE: over.demo ?? false });
}

/** A payment as Razorpay's payment entity shows it, in the fields the refund check reads. */
const rzpPayment = (over: Record<string, unknown> = {}) => ({
  id: 'pay_AbCdEf1234567',
  status: 'captured',
  captured: true,
  amount: 52_730,
  amount_refunded: 0,
  ...over,
});

describe('GET /razorpay/status', () => {
  it('says which source is on, the public key id, and whether manual imports are open', () => {
    expect(controller(null).status()).toEqual({
      source: 'testmode',
      ready: true,
      keyId: KEY_ID,
      importsOpen: true,
    });
  });

  it('says imports are closed on the public demo, and gives no key when test mode is off', () => {
    expect(controller(null, { demo: true, ready: false }).status()).toEqual({
      source: 'synthetic',
      ready: false,
      keyId: null,
      importsOpen: false,
    });
  });
});

describe('test order input', () => {
  it.each([
    [{ amountPaise: 100 }, true],
    [{ amountPaise: 1_000_000, receipt: 'ORD-261026-AB12' }, true],
    [{ amountPaise: 99 }, false],
    [{ amountPaise: 1_000_001 }, false],
    [{ amountPaise: 150.5 }, false],
    [{ amountPaise: '500' }, false],
    [{ amountPaise: 500, receipt: 'has space' }, false],
    [{ amountPaise: 500, receipt: 'x'.repeat(41) }, false],
    [{ amountPaise: 500, receipt: '' }, false],
    [{ amountPaise: 500, currency: 'USD' }, false],
    [{}, false],
  ])('%j is %s', (input, ok) => {
    expect(testOrderSchema.safeParse(input).success).toBe(ok);
  });
});

describe('test refund input', () => {
  it.each([
    [{ paymentId: 'pay_AbCdEf1234567' }, true],
    [{ paymentId: 'pay_AbCdEf1234567', amountPaise: 500 }, true],
    [{ paymentId: 'order_AbCdEf1234567' }, false],
    [{ paymentId: 'pay_' }, false],
    [{ paymentId: 'pay_AbCdEf1234567; drop table', amountPaise: 500 }, false],
    [{ paymentId: 'pay_AbCdEf1234567', amountPaise: 50 }, false],
    [{ amountPaise: 500 }, false],
  ])('%j is %s', (input, ok) => {
    expect(testRefundSchema.safeParse(input).success).toBe(ok);
  });
});

describe('generateReceipt', () => {
  it('is today in India, then four hex digits: easy to read, and a fine ledger order_ref', () => {
    // 2026-10-25 20:00 UTC is already 26 October in India.
    const receipt = generateReceipt(new Date('2026-10-25T20:00:00Z'));
    expect(receipt).toMatch(/^ORD-261026-[0-9A-F]{4}$/);
  });

  it('is different each time', () => {
    const seen = new Set(Array.from({ length: 40 }, () => generateReceipt()));
    expect(seen.size).toBeGreaterThan(30);
  });
});

describe('POST /razorpay/test-orders', () => {
  it('creates the order with the given receipt and returns what Checkout needs', async () => {
    const made: unknown[] = [];
    const c = controller({
      createOrder: (input) => {
        made.push(input);
        return Promise.resolve({
          id: 'order_Abc123',
          amount: input.amountPaise,
          receipt: input.receipt,
        });
      },
    });
    const out = await c.createOrder({ amountPaise: 52_730, receipt: 'ORD-100002' });
    expect(out).toEqual({
      orderId: 'order_Abc123',
      amountPaise: 52_730,
      receipt: 'ORD-100002',
      currency: 'INR',
      keyId: KEY_ID,
    });
    expect(made).toEqual([
      { amountPaise: 52_730, receipt: 'ORD-100002', notes: { made_by: 'ziro-test-helper' } },
    ]);
  });

  it('makes up a receipt when none is given', async () => {
    const c = controller({
      createOrder: (input) =>
        Promise.resolve({ id: 'order_Abc123', amount: input.amountPaise, receipt: input.receipt }),
    });
    expect((await c.createOrder({ amountPaise: 100 })).receipt).toMatch(/^ORD-\d{6}-[0-9A-F]{4}$/);
  });

  it('is a conflict, with the reason, when test mode is not switched on', async () => {
    await expect(controller(null).createOrder({ amountPaise: 100 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('turns a Razorpay error into a 502 that carries the status and code, nothing else', async () => {
    const c = controller({
      createOrder: () =>
        Promise.reject(
          new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'Order amount less than minimum'),
        ),
    });
    const error = await c.createOrder({ amountPaise: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).toContain('BAD_REQUEST_ERROR');
  });

  it('does not pass on an answer that is not an order', async () => {
    const c = controller({ createOrder: () => Promise.resolve({ nope: true }) });
    await expect(c.createOrder({ amountPaise: 100 })).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('POST /razorpay/test-refunds', () => {
  it('refunds the whole payment when no amount is given', async () => {
    const asked: unknown[] = [];
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment()),
      refundPayment: (paymentId, input) => {
        asked.push([paymentId, input]);
        return Promise.resolve({ id: 'rfnd_Abc123', payment_id: paymentId, amount: 52_730 });
      },
    });
    const out = await c.refund({ paymentId: 'pay_AbCdEf1234567' });
    expect(out).toEqual({
      refundId: 'rfnd_Abc123',
      paymentId: 'pay_AbCdEf1234567',
      amountPaise: 52_730,
    });
    expect(asked).toEqual([['pay_AbCdEf1234567', { notes: { made_by: 'ziro-test-helper' } }]]);
  });

  it('passes a partial amount on', async () => {
    const asked: unknown[] = [];
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment()),
      refundPayment: (paymentId, input) => {
        asked.push(input);
        return Promise.resolve({ id: 'rfnd_Abc123', payment_id: paymentId, amount: 500 });
      },
    });
    await c.refund({ paymentId: 'pay_AbCdEf1234567', amountPaise: 500 });
    expect(asked).toEqual([{ amountPaise: 500, notes: { made_by: 'ziro-test-helper' } }]);
  });

  it('is a conflict when test mode is off', async () => {
    await expect(
      controller(null).refund({ paymentId: 'pay_AbCdEf1234567' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('POST /razorpay/test-refunds: looking before asking', () => {
  const refundSpy = () => {
    const asked: unknown[] = [];
    return {
      asked,
      refundPayment: (paymentId: string) => {
        asked.push(paymentId);
        return Promise.resolve({ id: 'rfnd_Abc123', payment_id: paymentId, amount: 100 });
      },
    };
  };

  it('does not ask Razorpay to refund a payment that is only authorized, and says why', async () => {
    const spy = refundSpy();
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment({ status: 'authorized', captured: false })),
      refundPayment: spy.refundPayment,
    });
    const error = await c.refund({ paymentId: 'pay_AbCdEf1234567' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toContain('Not captured yet');
    expect(spy.asked).toEqual([]);
  });

  it('does not ask again for a payment that is already fully refunded', async () => {
    const spy = refundSpy();
    const c = controller({
      fetchPayment: () =>
        Promise.resolve(rzpPayment({ status: 'refunded', amount_refunded: 52_730 })),
      refundPayment: spy.refundPayment,
    });
    await expect(c.refund({ paymentId: 'pay_AbCdEf1234567' })).rejects.toThrow(
      'Already fully refunded',
    );
    expect(spy.asked).toEqual([]);
  });

  it('refuses more than what is left, naming what is left, and sends nothing', async () => {
    const spy = refundSpy();
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment({ amount: 50_000, amount_refunded: 20_000 })),
      refundPayment: spy.refundPayment,
    });
    const error = await c
      .refund({ paymentId: 'pay_AbCdEf1234567', amountPaise: 30_001 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as Error).message).toContain('₹300.00');
    expect(spy.asked).toEqual([]);
  });

  it('allows exactly what is left of a partly refunded payment', async () => {
    const spy = refundSpy();
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment({ amount: 50_000, amount_refunded: 20_000 })),
      refundPayment: spy.refundPayment,
    });
    await c.refund({ paymentId: 'pay_AbCdEf1234567', amountPaise: 30_000 });
    expect(spy.asked).toEqual(['pay_AbCdEf1234567']);
  });

  it("explains Razorpay's reasonless refund refusal instead of repeating it", async () => {
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment()),
      refundPayment: () =>
        Promise.reject(new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'invalid request sent')),
    });
    const error = await c.refund({ paymentId: 'pay_AbCdEf1234567' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).toContain(REFUND_NO_REASON);
  });

  it('quotes any other reason Razorpay gives, with the status and code', async () => {
    const c = controller({
      fetchPayment: () => Promise.resolve(rzpPayment()),
      refundPayment: () =>
        Promise.reject(
          new RazorpayApiError(
            400,
            'BAD_REQUEST_ERROR',
            'Your account does not have enough balance to carry out the refund operation.',
          ),
        ),
    });
    const error = await c.refund({ paymentId: 'pay_AbCdEf1234567' }).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Razorpay said: "Your account does not have enough balance to carry out the refund operation" (HTTP 400, BAD_REQUEST_ERROR).',
    );
  });

  it('does not pass on an answer that is not a payment', async () => {
    const c = controller({ fetchPayment: () => Promise.resolve({ nope: true }) });
    await expect(c.refund({ paymentId: 'pay_AbCdEf1234567' })).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

describe('test payments query', () => {
  it.each([
    [{ from: '2026-10-01', to: '2026-10-26' }, true],
    [{ from: '2026-10-26', to: '2026-10-26' }, true],
    [{ from: '2026-10-27', to: '2026-10-26' }, false],
    [{ from: '2026-02-30', to: '2026-03-01' }, false],
    [{ from: 'yesterday', to: '2026-10-26' }, false],
    [{ from: '2026-01-01', to: '2026-04-03' }, true],
    [{ from: '2026-01-01', to: '2026-04-04' }, false],
    [{ from: '2026-10-01' }, false],
    [{ from: '2026-10-01', to: '2026-10-26', status: 'captured' }, false],
  ])('%j is %s', (input, ok) => {
    expect(testPaymentsQuery.safeParse(input).success).toBe(ok);
  });
});

describe('GET /razorpay/test-payments', () => {
  const record = (over: Record<string, unknown>): { record: RzpPayment; raw: unknown } => ({
    record: {
      paymentId: 'pay_AbCdEf1234567',
      orderId: 'order_Abc123',
      receipt: 'ORD-1',
      method: 'upi',
      status: 'captured',
      captured: true,
      amount: 50_000n,
      amountRefunded: 0n,
      createdAt: '2026-10-26T01:00:00+05:30',
      businessDate: '2026-10-26',
      ...over,
    } as unknown as RzpPayment,
    raw: {},
  });
  const answer = (
    items: { record: RzpPayment; raw: unknown }[],
    provenance: Partial<FetchResult<RzpPayment>['provenance']> = {},
  ): FetchResult<RzpPayment> => ({
    source: 'razorpay_testmode',
    items,
    provenance: {
      entity: 'payments',
      source: 'razorpay_testmode',
      requests: 2,
      warnings: [],
      ...provenance,
    },
  });
  const range = { from: '2026-10-01', to: '2026-10-26' };

  it('lists what the account holds, newest first, with money as paise text and refund rules applied', async () => {
    const asked: unknown[] = [];
    const c = controller(null, {
      account: {
        fetchPayments: (r) => {
          asked.push(r);
          return Promise.resolve(
            answer([
              record({ paymentId: 'pay_old000001', createdAt: '2026-10-20T10:00:00+05:30' }),
              record({
                paymentId: 'pay_new000001',
                createdAt: '2026-10-26T10:00:00+05:30',
                status: 'authorized',
                captured: false,
              }),
              record({
                paymentId: 'pay_part00001',
                createdAt: '2026-10-25T10:00:00+05:30',
                amountRefunded: 20_000n,
              }),
            ]),
          );
        },
      },
    });
    const out = await c.testPayments(range);
    expect(asked).toEqual([range]);
    expect(out.payments.map((p) => p.paymentId)).toEqual([
      'pay_new000001',
      'pay_part00001',
      'pay_old000001',
    ]);
    const [authorized, partly, whole] = out.payments;
    expect(authorized).toMatchObject({
      amountPaise: '50000',
      canRefund: false,
      refundablePaise: '50000',
    });
    expect(authorized?.cannotRefundBecause).toContain('Not captured yet');
    expect(partly).toMatchObject({
      amountRefundedPaise: '20000',
      refundablePaise: '30000',
      canRefund: true,
      cannotRefundBecause: null,
    });
    expect(whole?.canRefund).toBe(true);
    expect(out).toMatchObject({ keyId: KEY_ID, truncated: false, complete: true, warnings: [] });
  });

  it('says so when Razorpay stopped part-way, and keeps what it got', async () => {
    const c = controller(null, {
      account: {
        fetchPayments: () =>
          Promise.resolve(
            answer([record({})], {
              incomplete: [{ what: 'payments', fetched: 100, reason: 'HTTP 503' }],
              warnings: ['one order could not be found'],
            }),
          ),
      },
    });
    const out = await c.testPayments(range);
    expect(out.complete).toBe(false);
    expect(out.payments).toHaveLength(1);
    expect(out.warnings).toEqual(['one order could not be found']);
  });

  it('shows an empty account as an empty list, never as made-up rows', async () => {
    const c = controller(null, { account: { fetchPayments: () => Promise.resolve(answer([])) } });
    expect((await c.testPayments(range)).payments).toEqual([]);
  });

  it('is a conflict, with the reason, when test mode is not switched on', async () => {
    await expect(controller(null).testPayments(range)).rejects.toBeInstanceOf(ConflictException);
  });

  it('turns a Razorpay failure into a 502 with the reason in words', async () => {
    const c = controller(null, {
      account: {
        fetchPayments: () =>
          Promise.reject(
            new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'The api key provided is invalid'),
          ),
      },
    });
    const error = await c.testPayments(range).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as Error).message).toContain('Razorpay rejected your test keys');
  });
});
