// Zod schemas for Razorpay's API entities, transcribed from Razorpay's documentation (read
// 2026-10-22). Pure and IO-free: shared by the ingest layer and by datagen's fidelity tests.
//
//   Payment     https://razorpay.com/docs/api/payments/fetch-with-id
//   Payments    https://razorpay.com/docs/api/payments/fetch-all-payments
//   Refund      https://razorpay.com/docs/api/refunds/fetch-with-id
//   Settlement  https://razorpay.com/docs/api/settlements/fetch-with-id
//   Recon       https://razorpay.com/docs/api/settlements/fetch-recon
//   Order       https://razorpay.com/docs/api/orders/fetch-with-id
//
// Each entity has TWO schemas built from the same field definitions, so they cannot drift:
//   - `xSchema`        strict and complete: exactly the documented fields, no others. Used to prove
//                      that synthetic data has Razorpay's shape.
//   - `xIngestSchema`  tolerant: only the fields Ziro reads, unknown fields allowed and kept.
//                      Real responses carry fields the docs omit (amount_captured, token_id, ...),
//                      so the ingest side must not reject them, but must reject a missing or
//                      mistyped field it depends on.
// Where the docs disagree with their own samples both are accepted: `notes` is documented as an
// object but empty notes appear as `[]` in the samples.
import { z } from 'zod';

const int = z.number().int();
const text = z.string();
const nullableText = z.string().nullable();

export const notesSchema = z.union([z.tuple([]), z.record(z.string(), z.string())]);

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `must look like ${prefix}_...`);

export const orderFields = {
  id: id('order'),
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
};

export const paymentFields = {
  id: id('pay'),
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
  created_at: int,
};

/** Present only when `method` is `upi`. */
export const paymentUpiField = z.strictObject({
  payer_account_type: z.enum(['bank_account', 'credit_card', 'wallet', 'credit_line']),
  vpa: text,
  flow: z.enum(['intent', 'collect', 'in_app']),
});

export const refundFields = {
  id: id('rfnd'),
  entity: z.literal('refund'),
  amount: int,
  currency: z.literal('INR'),
  payment_id: id('pay'),
  notes: notesSchema,
  receipt: nullableText,
  acquirer_data: z.record(z.string(), nullableText),
  created_at: int,
  batch_id: nullableText,
  status: z.enum(['pending', 'processed', 'failed']),
  speed_processed: text,
  speed_requested: text,
};

export const settlementFields = {
  id: id('setl'),
  entity: z.literal('settlement'),
  amount: int,
  status: z.enum(['created', 'processed', 'failed']),
  fees: int,
  tax: int,
  utr: text,
  created_at: int,
};

export const reconItemFields = {
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
  settlement_id: id('setl'),
  posted_at: int.nullable(),
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
};

// --- strict: exactly the documented shape --------------------------------------------------------

export const orderSchema = z.strictObject(orderFields);
export const paymentSchema = z.strictObject({ ...paymentFields, upi: paymentUpiField.optional() });
export const refundSchema = z.strictObject(refundFields);
export const settlementSchema = z.strictObject(settlementFields);
/** `credit_type` is absent on adjustment lines, as in the docs' sample. */
export const reconItemSchema = z.strictObject({ ...reconItemFields, credit_type: text.optional() });

export const collectionSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ entity: z.literal('collection'), count: int, items: z.array(item) });

// --- tolerant: only what Ziro reads --------------------------------------------------------------

/** Keeps an object's unknown fields (Razorpay adds fields without notice) but pins what we use. */
export const orderIngestSchema = z.looseObject({
  id: orderFields.id,
  receipt: orderFields.receipt.nullish(),
  created_at: orderFields.created_at,
});

export const paymentIngestSchema = z.looseObject({
  id: paymentFields.id,
  amount: paymentFields.amount,
  status: paymentFields.status,
  order_id: paymentFields.order_id.nullish(),
  method: paymentFields.method,
  amount_refunded: paymentFields.amount_refunded.default(0),
  captured: paymentFields.captured,
  fee: paymentFields.fee.nullish(),
  tax: paymentFields.tax.nullish(),
  created_at: paymentFields.created_at,
});

export const refundIngestSchema = z.looseObject({
  id: refundFields.id,
  amount: refundFields.amount,
  payment_id: refundFields.payment_id,
  status: refundFields.status,
  created_at: refundFields.created_at,
});

export const settlementIngestSchema = z.looseObject({
  id: settlementFields.id,
  amount: settlementFields.amount,
  status: settlementFields.status,
  fees: settlementFields.fees.default(0),
  tax: settlementFields.tax.default(0),
  utr: settlementFields.utr.nullish(),
  created_at: settlementFields.created_at,
});

export const reconItemIngestSchema = z.looseObject({
  entity_id: reconItemFields.entity_id,
  type: reconItemFields.type,
  debit: reconItemFields.debit,
  credit: reconItemFields.credit,
  amount: reconItemFields.amount,
  fee: reconItemFields.fee.default(0),
  tax: reconItemFields.tax.default(0),
  settled_at: reconItemFields.settled_at,
  settlement_id: reconItemFields.settlement_id,
  payment_id: reconItemFields.payment_id.nullish(),
  order_id: reconItemFields.order_id.nullish(),
  description: reconItemFields.description.nullish(),
});

/** A Razorpay list response. Items stay `unknown` here so the caller can keep each original. */
export const collectionEnvelopeSchema = z.looseObject({
  entity: z.literal('collection'),
  count: int,
  items: z.array(z.unknown()),
});

export type RawOrder = z.infer<typeof orderIngestSchema>;
export type RawPayment = z.infer<typeof paymentIngestSchema>;
export type RawRefund = z.infer<typeof refundIngestSchema>;
export type RawSettlement = z.infer<typeof settlementIngestSchema>;
export type RawReconItem = z.infer<typeof reconItemIngestSchema>;
