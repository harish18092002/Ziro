import {
  type RzpPayment,
  type RzpRefund,
  type RzpSettlement,
  rzpPaymentSchema,
  rzpRefundSchema,
  rzpSettlementSchema,
  type SettlementItem,
  settlementItemSchema,
} from '@ziro/core/domain';
import type {
  RawOrder,
  RawPayment,
  RawReconItem,
  RawRefund,
  RawSettlement,
} from '@ziro/core/razorpay';
import { instantFromEpoch, istBusinessDate } from '@ziro/core/time';
import type { z } from 'zod';
import { MappingError } from './errors.js';
import { deterministicUuid, importHash } from './identity.js';
import type { Sourced, SourceLabel } from './source.js';

/** A record that passed the tolerant ingest schema, with the original it was parsed from. */
export interface RawEntry<T> {
  readonly parsed: T;
  /** Exactly as received, extras included: this is what gets hashed and stored as `raw`. */
  readonly original: unknown;
}

export interface MapContext {
  readonly runId: string;
  readonly source: SourceLabel;
}

/** Validates a candidate against a domain schema; a failure names the record, not its contents. */
function build<T>(schema: z.ZodType<T>, label: string, candidate: unknown): T {
  const result = schema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(record)'}: ${i.message}`,
    );
    throw new MappingError(`${label} is not a valid record: ${issues.join('; ')}`);
  }
  return result.data;
}

/** order id -> receipt. A blank receipt is treated as none. */
export function receiptsByOrderId(
  orders: readonly RawEntry<RawOrder>[],
): Map<string, string | null> {
  return new Map(
    orders.map(({ parsed }) => [
      parsed.id,
      parsed.receipt === undefined || parsed.receipt === '' ? null : parsed.receipt,
    ]),
  );
}

export function mapPayment(
  { parsed: p, original }: RawEntry<RawPayment>,
  receipts: ReadonlyMap<string, string | null>,
  ctx: MapContext,
): Sourced<RzpPayment> {
  // Razorpay reports fee/tax as null until a payment is captured. Nothing was charged on an
  // uncaptured payment, so 0 is true; on a captured one a missing fee is bad data, never a zero.
  if ((p.fee == null || p.tax == null) && p.captured) {
    throw new MappingError(`payment ${p.id} is captured but has no fee or tax`);
  }
  const record = build(rzpPaymentSchema, `payment ${p.id}`, {
    id: deterministicUuid(ctx.runId, 'rzp_payment', p.id),
    runId: ctx.runId,
    source: ctx.source,
    sourceRef: p.id,
    importHash: importHash(original),
    paymentId: p.id,
    orderId: p.order_id ?? null,
    receipt: p.order_id == null ? null : (receipts.get(p.order_id) ?? null),
    currency: p.currency,
    amount: p.amount,
    fee: p.fee ?? 0,
    tax: p.tax ?? 0,
    amountRefunded: p.amount_refunded,
    method: p.method,
    status: p.status,
    captured: p.captured,
    createdAt: instantFromEpoch(p.created_at),
    businessDate: istBusinessDate(p.created_at),
  });
  return { record, raw: original };
}

export function mapRefund(
  { parsed: r, original }: RawEntry<RawRefund>,
  ctx: MapContext,
): Sourced<RzpRefund> {
  const record = build(rzpRefundSchema, `refund ${r.id}`, {
    id: deterministicUuid(ctx.runId, 'rzp_refund', r.id),
    runId: ctx.runId,
    source: ctx.source,
    sourceRef: r.id,
    importHash: importHash(original),
    refundId: r.id,
    paymentId: r.payment_id,
    currency: r.currency,
    amount: r.amount,
    status: r.status,
    createdAt: instantFromEpoch(r.created_at),
    businessDate: istBusinessDate(r.created_at),
  });
  return { record, raw: original };
}

export function mapSettlement(
  { parsed: s, original }: RawEntry<RawSettlement>,
  ctx: MapContext,
): Sourced<RzpSettlement> {
  const record = build(rzpSettlementSchema, `settlement ${s.id}`, {
    id: deterministicUuid(ctx.runId, 'rzp_settlement', s.id),
    runId: ctx.runId,
    source: ctx.source,
    sourceRef: s.id,
    importHash: importHash(original),
    settlementId: s.id,
    amount: s.amount,
    fees: s.fees,
    tax: s.tax,
    utr: s.utr == null || s.utr === '' ? null : s.utr,
    status: s.status,
    createdAt: instantFromEpoch(s.created_at),
    businessDate: istBusinessDate(s.created_at),
  });
  return { record, raw: original };
}

/** One line of the settlement recon report. Its source reference is `<settlement id>:<entity id>`. */
export function mapReconItem(
  { parsed: i, original }: RawEntry<RawReconItem>,
  ctx: MapContext,
): Sourced<SettlementItem> {
  const sourceRef = `${i.settlement_id}:${i.entity_id}`;
  const record = build(settlementItemSchema, `recon line ${sourceRef}`, {
    id: deterministicUuid(ctx.runId, 'settlement_item', sourceRef),
    runId: ctx.runId,
    source: ctx.source,
    sourceRef,
    importHash: importHash(original),
    settlementId: i.settlement_id,
    itemType: i.type,
    entityId: i.entity_id,
    paymentId: i.payment_id ?? null,
    orderId: i.order_id ?? null,
    currency: i.currency,
    amount: i.amount,
    fee: i.fee,
    tax: i.tax,
    debit: i.debit,
    credit: i.credit,
    settledAt: instantFromEpoch(i.settled_at),
    description: i.description ?? null,
  });
  return { record, raw: original };
}

/**
 * Chronological, then by source reference. Both adapters sort the same way, so the same data gives
 * the same list whichever adapter produced it; nothing relies on Razorpay's own list order.
 */
export function sortChronologically<T extends { readonly sourceRef: string }>(
  items: readonly Sourced<T>[],
  time: (record: T) => string,
): Sourced<T>[] {
  return [...items].sort((a, b) => {
    const ta = time(a.record);
    const tb = time(b.record);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.record.sourceRef < b.record.sourceRef
      ? -1
      : a.record.sourceRef > b.record.sourceRef
        ? 1
        : 0;
  });
}
