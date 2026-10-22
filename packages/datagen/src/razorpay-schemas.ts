// Strict zod schemas for the Razorpay API shapes datagen emits, transcribed from Razorpay's
// documentation (read 2026-10-22). Datagen's tests validate every output file against them, so a
// renamed, missing or mistyped field is caught. Strict on purpose: an unexpected key fails too.
//
//   Payment     https://razorpay.com/docs/api/payments/fetch-with-id
//   Payments    https://razorpay.com/docs/api/payments/fetch-all-payments
//   Refund      https://razorpay.com/docs/api/refunds/fetch-with-id
//   Settlement  https://razorpay.com/docs/api/settlements/fetch-with-id
//   Recon       https://razorpay.com/docs/api/settlements/fetch-recon
//   Order       https://razorpay.com/docs/api/orders/fetch-with-id
//
// Where the docs disagree with their own samples they are accepted both ways: `notes` is
// documented as an object but empty notes appear as `[]` in the samples.
import { z } from 'zod';

const int = z.number().int();
const text = z.string();
const nullableText = z.string().nullable();

export const notesSchema = z.union([z.tuple([]), z.record(z.string(), z.string())]);

export const orderSchema = z.strictObject({
  id: z.string().regex(/^order_[A-Za-z0-9]{14}$/),
  entity: z.literal('order'),
  amount: int,
  amount_paid: int,
  amount_due: int,
  currency: z.literal('INR'),
  receipt: nullableText,
  offer_id: nullableText,
  status: z.enum(['created', 'attempted', 'paid']),
  attempts: int,
  notes: notesSchema,
  created_at: int,
});

export const paymentSchema = z.strictObject({
  id: z.string().regex(/^pay_[A-Za-z0-9]{14}$/),
  entity: z.literal('payment'),
  amount: int,
  currency: z.literal('INR'),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
  order_id: nullableText,
  invoice_id: nullableText,
  international: z.boolean(),
  method: z.enum(['card', 'netbanking', 'wallet', 'emi', 'upi', 'paylater']),
  amount_refunded: int,
  refund_status: z.enum(['partial', 'full']).nullable(),
  captured: z.boolean(),
  description: nullableText,
  card_id: nullableText,
  bank: nullableText,
  wallet: nullableText,
  vpa: nullableText,
  email: text,
  contact: text,
  notes: notesSchema,
  /** Fee including GST. Null until captured. */
  fee: int.nullable(),
  /** The GST part of `fee`. */
  tax: int.nullable(),
  error_code: nullableText,
  error_description: nullableText,
  error_source: nullableText,
  error_step: nullableText,
  error_reason: nullableText,
  acquirer_data: z.record(z.string(), nullableText),
  upi: z
    .strictObject({
      payer_account_type: z.enum(['bank_account', 'credit_card', 'wallet', 'credit_line']),
      vpa: text,
      flow: z.enum(['intent', 'collect', 'in_app']),
    })
    .optional(),
  created_at: int,
});

export const refundSchema = z.strictObject({
  id: z.string().regex(/^rfnd_[A-Za-z0-9]{14}$/),
  entity: z.literal('refund'),
  amount: int,
  currency: z.literal('INR'),
  payment_id: z.string().regex(/^pay_[A-Za-z0-9]{14}$/),
  notes: notesSchema,
  receipt: nullableText,
  acquirer_data: z.record(z.string(), nullableText),
  created_at: int,
  batch_id: nullableText,
  status: z.enum(['pending', 'processed', 'failed']),
  speed_processed: text,
  speed_requested: text,
});

export const settlementSchema = z.strictObject({
  id: z.string().regex(/^setl_[A-Za-z0-9]{14}$/),
  entity: z.literal('settlement'),
  amount: int,
  status: z.enum(['created', 'processed', 'failed']),
  fees: int,
  tax: int,
  utr: text,
  created_at: int,
});

export const reconItemSchema = z.strictObject({
  entity_id: text,
  type: z.enum(['payment', 'refund', 'transfer', 'adjustment']),
  debit: int,
  credit: int,
  amount: int,
  currency: z.literal('INR'),
  fee: int,
  tax: int,
  on_hold: z.boolean(),
  settled: z.boolean(),
  created_at: int,
  settled_at: int,
  settlement_id: z.string().regex(/^setl_[A-Za-z0-9]{14}$/),
  posted_at: int.nullable(),
  /** Absent on adjustment lines, as in the docs' sample. */
  credit_type: text.optional(),
  settlement_utr: text,
  order_id: nullableText,
  order_receipt: nullableText,
  method: nullableText,
  card_network: nullableText,
  card_issuer: nullableText,
  card_type: nullableText,
  dispute_id: nullableText,
  description: nullableText,
  notes: notesSchema.nullable(),
  payment_id: nullableText,
});

export const collectionSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    entity: z.literal('collection'),
    count: int,
    items: z.array(item),
  });
