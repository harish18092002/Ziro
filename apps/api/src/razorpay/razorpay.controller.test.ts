import { BadGatewayException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import {
  generateReceipt,
  RazorpayController,
  testOrderSchema,
  testRefundSchema,
} from './razorpay.controller.js';
import type { RazorpaySourceFactory } from './razorpay.factory.js';
import type { RazorpayWriter } from './sdk-client.js';

const KEY_ID = 'rzp_test_AbCdEf123456';

function controller(
  writer: Partial<RazorpayWriter> | null,
  over: { demo?: boolean; ready?: boolean } = {},
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
  } as unknown as RazorpaySourceFactory;
  return new RazorpayController(factory, { DEMO_MODE: over.demo ?? false });
}

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
