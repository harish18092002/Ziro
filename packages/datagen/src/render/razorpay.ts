// Razorpay-shaped entities, with field names and types taken from Razorpay's own API reference.
// Read on 2026-10-22:
//   Payment     https://razorpay.com/docs/api/payments/fetch-with-id
//   Payments    https://razorpay.com/docs/api/payments/fetch-all-payments   (collection wrapper)
//   Refund      https://razorpay.com/docs/api/refunds/fetch-with-id
//   Settlement  https://razorpay.com/docs/api/settlements/fetch-with-id
//   Settlements https://razorpay.com/docs/api/settlements/fetch-all          (collection wrapper)
//   Recon       https://razorpay.com/docs/api/settlements/fetch-recon        (collection wrapper)
//   Order       https://razorpay.com/docs/api/orders/fetch-with-id
//
// Fidelity notes:
//  - Amounts are integers in paise. Timestamps are integer Unix seconds.
//  - An empty `notes` is written as `[]`, as Razorpay's own samples do (the docs call it an object).
//  - Payment `fee` includes GST and `tax` is the GST part of it (ADR-004).
//  - Settlement `fees` and `tax` are 0 for a normal settlement (docs); the real fees are in recon.
//  - A recon payment line has credit = amount - fee; a refund line has debit = amount and fee 0
//    (both from the docs' samples). An adjustment line has no `credit_type`, as in the sample.
//  - The docs' samples do not show a refund returning the fee, so refunds here do not.
// Anything the docs leave unspecified is a synthetic choice, listed in packages/datagen/README.md.
import type { ItemRec, OrderRec, PaymentRec, RefundRec, SettlementRec } from '../world/types.js';
import type { Json } from './json.js';

type Obj = { [key: string]: Json };

const notesJson = (notes: Record<string, string> | null): Json =>
  notes === null ? [] : { ...notes };

export function orderJson(order: OrderRec): Obj {
  return {
    id: order.id,
    entity: 'order',
    amount: order.amount,
    amount_paid: order.amount,
    amount_due: 0n,
    currency: 'INR',
    receipt: order.receipt,
    offer_id: null,
    status: 'paid',
    attempts: order.attempts,
    notes: notesJson(order.notes),
    created_at: order.createdAt,
  };
}

export function paymentJson(payment: PaymentRec): Obj {
  const failed = payment.status === 'failed';
  const refundStatus =
    payment.amountRefunded === 0n
      ? null
      : payment.amountRefunded === payment.amount
        ? 'full'
        : 'partial';

  let acquirer: Obj = {};
  if (!failed) {
    if (payment.method === 'card') {
      acquirer = { auth_code: payment.rrn.slice(0, 6), arn: `1${payment.rrn}0`, rrn: payment.rrn };
    } else if (payment.method === 'upi') {
      acquirer = { rrn: payment.rrn };
    } else {
      acquirer = { bank_transaction_id: payment.rrn.slice(0, 7) };
    }
  }

  return {
    id: payment.id,
    entity: 'payment',
    amount: payment.amount,
    currency: 'INR',
    status: payment.status,
    order_id: payment.orderId,
    invoice_id: null,
    international: false,
    method: payment.method,
    amount_refunded: payment.amountRefunded,
    refund_status: refundStatus,
    captured: !failed,
    description: payment.description,
    card_id: payment.cardId,
    bank: payment.bank4,
    wallet: null,
    vpa: payment.vpa,
    email: payment.customer.email,
    contact: payment.customer.contact,
    notes: notesJson(payment.notes),
    fee: payment.fee,
    tax: payment.tax,
    error_code: payment.error?.code ?? null,
    error_description: payment.error?.description ?? null,
    error_source: payment.error?.source ?? null,
    error_step: payment.error?.step ?? null,
    error_reason: payment.error?.reason ?? null,
    acquirer_data: acquirer,
    ...(payment.method === 'upi' && !failed
      ? {
          upi: {
            payer_account_type: 'bank_account',
            vpa: payment.vpa,
            flow: payment.rrn.endsWith('1') || payment.rrn.endsWith('3') ? 'intent' : 'collect',
          },
        }
      : {}),
    created_at: payment.createdAt,
  };
}

export function refundJson(refund: RefundRec): Obj {
  return {
    id: refund.id,
    entity: 'refund',
    amount: refund.amount,
    currency: 'INR',
    payment_id: refund.paymentId,
    notes: { ...refund.notes },
    receipt: null,
    acquirer_data: { arn: `${refund.createdAt}0000` },
    created_at: refund.createdAt,
    batch_id: null,
    status: 'processed',
    speed_processed: 'normal',
    speed_requested: 'normal',
  };
}

export function settlementJson(settlement: SettlementRec): Obj {
  return {
    id: settlement.id,
    entity: 'settlement',
    amount: settlement.amount,
    status: 'processed',
    fees: 0n,
    tax: 0n,
    utr: settlement.utr,
    created_at: settlement.createdAt,
  };
}

export function reconItemJson(item: ItemRec, utr: string): Obj {
  return {
    entity_id: item.entityId,
    type: item.type,
    debit: item.debit,
    credit: item.credit,
    amount: item.amount,
    currency: 'INR',
    fee: item.fee,
    tax: item.tax,
    on_hold: false,
    settled: true,
    created_at: item.createdAt,
    settled_at: item.settledAt,
    settlement_id: item.settlementId,
    posted_at: null,
    ...(item.type === 'adjustment' ? {} : { credit_type: 'default' }),
    settlement_utr: utr,
    order_id: item.orderId,
    order_receipt: item.receipt,
    method: item.method,
    card_network: item.cardNetwork,
    card_issuer: item.cardIssuer,
    card_type: item.cardType,
    dispute_id: item.disputeId,
    description: item.description,
    notes: [],
    payment_id: item.paymentId,
  };
}
