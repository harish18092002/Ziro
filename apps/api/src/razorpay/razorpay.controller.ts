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
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { formatRupees, paise } from '@ziro/core/money';
import { addDaysToBusinessDate, isBusinessDate, istBusinessDate } from '@ziro/core/time';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import {
  MappingError,
  RazorpayApiError,
  RazorpayConfigError,
  RazorpayResponseError,
} from './errors.js';
import { type Action, explainRazorpayFailure } from './explain.js';
import { RazorpaySourceFactory } from './razorpay.factory.js';
import { refundState } from './refundability.js';

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

/** How many days one listing may cover, and how many rows it returns: it is a live view, not an export. */
const LIST_WINDOW_DAYS = 93;
const LIST_MAX_ROWS = 500;

const day = z.string().refine(isBusinessDate, {
  error: 'must be a real calendar date written YYYY-MM-DD',
});
export const testPaymentsQuery = z
  .strictObject({ from: day, to: day })
  .refine((q) => q.from <= q.to, { error: 'from must not be after to', path: ['to'] })
  .refine(
    (q) => !isBusinessDate(q.from) || q.to <= addDaysToBusinessDate(q.from, LIST_WINDOW_DAYS - 1),
    { error: `a listing covers at most ${LIST_WINDOW_DAYS} days`, path: ['to'] },
  );
export type TestPaymentsQuery = z.output<typeof testPaymentsQuery>;

/** The part of a payment the refund check needs, as Razorpay sends it. */
const fetchedPayment = z.object({
  status: z.string(),
  captured: z.boolean().nullish(),
  amount: z.number().int().nonnegative(),
  amount_refunded: z.number().int().nonnegative().nullish(),
});

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

  /**
   * What your test account holds right now, read from Razorpay when asked (not stored): the console's list of
   * payments, with whether each can be refunded and for how much. Read-only.
   */
  @Get('test-payments')
  async testPayments(@Query(new ZodPipe(testPaymentsQuery)) query: TestPaymentsQuery) {
    const source = this.account();
    const result = await this.call(() => source.fetchPayments({ from: query.from, to: query.to }));
    const rows = result.items
      .map(({ record: p }) => {
        const state = refundState({
          status: p.status,
          captured: p.captured,
          amount: p.amount,
          amountRefunded: p.amountRefunded,
        });
        return {
          paymentId: p.paymentId,
          orderId: p.orderId,
          receipt: p.receipt,
          method: p.method,
          status: p.status,
          captured: p.captured,
          amountPaise: p.amount.toString(),
          amountRefundedPaise: p.amountRefunded.toString(),
          refundablePaise: state.refundable.toString(),
          canRefund: state.allowed,
          cannotRefundBecause: state.why,
          createdAt: p.createdAt,
          businessDate: p.businessDate,
        };
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      from: query.from,
      to: query.to,
      keyId: this.razorpay.status().keyId,
      fetchedAt: new Date().toISOString(),
      payments: rows.slice(0, LIST_MAX_ROWS),
      truncated: rows.length > LIST_MAX_ROWS,
      /** False when Razorpay stopped answering part-way: what is listed is real, the rest is missing. */
      complete: (result.provenance.incomplete ?? []).length === 0,
      warnings: result.provenance.warnings,
    };
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

    // Look first. Razorpay refuses a refund it cannot pay with a bare "invalid request sent"; what can be known
    // beforehand (captured? how much is left?) is checked here and said in plain words.
    const seen = fetchedPayment.safeParse(
      await this.call(() => writer.fetchPayment(body.paymentId), 'refund'),
    );
    if (!seen.success) throw new BadGatewayException('Razorpay answered, but not with a payment');
    const state = refundState({
      status: seen.data.status,
      captured: seen.data.captured ?? seen.data.status === 'captured',
      amount: BigInt(seen.data.amount),
      amountRefunded: BigInt(seen.data.amount_refunded ?? 0),
    });
    if (!state.allowed)
      throw new ConflictException(state.why ?? 'This payment cannot be refunded.');
    if (body.amountPaise !== undefined && BigInt(body.amountPaise) > state.refundable) {
      throw new UnprocessableEntityException(
        `Only ${formatRupees(paise(state.refundable), { symbol: true })} of this payment can still be refunded.`,
      );
    }

    const made = await this.call(
      () =>
        writer.refundPayment(body.paymentId, {
          ...(body.amountPaise === undefined ? {} : { amountPaise: body.amountPaise }),
          notes: { made_by: 'ziro-test-helper' },
        }),
      'refund',
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

  private account() {
    try {
      return this.razorpay.account();
    } catch (error) {
      if (error instanceof RazorpayConfigError) throw new ConflictException(error.message);
      throw error;
    }
  }

  private async call<T>(run: () => Promise<T>, action: Action = 'other'): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RazorpayApiError) {
        throw new BadGatewayException(explainRazorpayFailure(error, action));
      }
      if (error instanceof MappingError || error instanceof RazorpayResponseError) {
        throw new BadGatewayException(`Razorpay sent something Ziro cannot read: ${error.message}`);
      }
      throw error;
    }
  }
}
