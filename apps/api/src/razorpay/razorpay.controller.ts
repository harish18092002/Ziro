import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';
import { istBusinessDate } from '@ziro/core/time';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import { RazorpaySourceFactory } from './razorpay.factory.js';

/** Razorpay's smallest order is 100 paise (Re 1). The ceiling keeps a typo from making a silly test order. */
const MIN_PAISE = 100;
const MAX_PAISE = 1_000_000;

export const testOrderSchema = z.strictObject({
  amountPaise: z.number().int().min(MIN_PAISE).max(MAX_PAISE),
  /** The merchant's own order number: it becomes the ledger's `order_ref`. Generated when left out. */
  receipt: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]{1,40}$/,
      'letters, digits, dot, dash and underscore, up to 40 characters',
    )
    .optional(),
});
export type TestOrderInput = z.output<typeof testOrderSchema>;

export const testRefundSchema = z.strictObject({
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/, 'must look like pay_XXXXXXXXXXXXXX'),
  /** Omitted means the whole payment. */
  amountPaise: z.number().int().min(MIN_PAISE).max(MAX_PAISE).optional(),
});
export type TestRefundInput = z.output<typeof testRefundSchema>;

const createdOrder = z.object({
  id: z.string().min(1),
  amount: z.number(),
  receipt: z.string().nullish(),
});
const createdRefund = z.object({
  id: z.string().min(1),
  payment_id: z.string(),
  amount: z.number(),
});

/** `ORD-261026-9F3A`: today's IST date and four random hex digits, so a test order number is easy to read. */
export function generateReceipt(now: Date = new Date()): string {
  const [year = '', month = '', day = ''] = istBusinessDate(Math.floor(now.getTime() / 1000)).split(
    '-',
  );
  return `ORD-${year.slice(2)}${month}${day}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

/**
 * The test-payments helper: reads which source is on, makes a test ORDER for the page's Checkout to pay, and
 * refunds a test payment. Everything here talks to your Razorpay TEST account only (the key check refuses
 * a live key before any request), moves no real money, and works only when RAZORPAY_SOURCE=testmode.
 */
@Controller('razorpay')
export class RazorpayController {
  constructor(
    private readonly razorpay: RazorpaySourceFactory,
    @Inject(ENV) private readonly env: Pick<Env, 'DEMO_MODE'>,
  ) {}

  /** Which source this server uses, and whether the manual imports (and so test mode) are switched on. */
  @Get('status')
  status() {
    const status = this.razorpay.status();
    return { ...status, importsOpen: !this.env.DEMO_MODE };
  }

  @Post('test-orders')
  @HttpCode(201)
  async createOrder(@Body(new ZodPipe(testOrderSchema)) body: TestOrderInput) {
    const writer = this.writer();
    const receipt = body.receipt ?? generateReceipt();
    const made = await this.call(() =>
      writer.createOrder({
        amountPaise: body.amountPaise,
        receipt,
        notes: { made_by: 'ziro-test-helper' },
      }),
    );
    const order = createdOrder.safeParse(made);
    if (!order.success) throw new BadGatewayException('Razorpay answered, but not with an order');
    return {
      orderId: order.data.id,
      amountPaise: order.data.amount,
      receipt: order.data.receipt ?? receipt,
      currency: 'INR',
      // The public half of the test key: Checkout needs it in the page. The secret never leaves the server.
      keyId: this.razorpay.status().keyId,
    };
  }

  @Post('test-refunds')
  @HttpCode(201)
  async refund(@Body(new ZodPipe(testRefundSchema)) body: TestRefundInput) {
    const writer = this.writer();
    const made = await this.call(() =>
      writer.refundPayment(body.paymentId, {
        ...(body.amountPaise === undefined ? {} : { amountPaise: body.amountPaise }),
        notes: { made_by: 'ziro-test-helper' },
      }),
    );
    const refund = createdRefund.safeParse(made);
    if (!refund.success) throw new BadGatewayException('Razorpay answered, but not with a refund');
    return {
      refundId: refund.data.id,
      paymentId: refund.data.payment_id,
      amountPaise: refund.data.amount,
    };
  }

  private writer() {
    try {
      return this.razorpay.writer();
    } catch (error) {
      if (error instanceof RazorpayConfigError) throw new ConflictException(error.message);
      throw error;
    }
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RazorpayApiError) throw new BadGatewayException(error.summary);
      throw error;
    }
  }
}
