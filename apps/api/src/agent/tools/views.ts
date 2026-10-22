// How records look to the model: compact JSON, integer paise as strings, free text wrapped as
// untrusted. Every function here is pure; the tools decide which rows to show.
import { type RecordRef, type RecordType } from '@ziro/core/domain';
import { inArray, and, eq } from 'drizzle-orm';
import type { Executor } from '../../db/executor.js';
import {
  bankLines,
  ledgerEntries,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
} from '../../db/schema.js';
import { identifier, untrusted } from '../untrusted.js';
import type { GroupInfo } from './repository.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export const str = (value: bigint): string => value.toString();
const iso = (date: Date): string => date.toISOString().replace('.000Z', 'Z');

export const ledgerView = (r: Row<typeof ledgerEntries>) => ({
  type: 'ledger_entry' as const,
  id: r.id,
  orderRef: identifier(r.orderRef),
  amountPaise: str(r.amountPaise),
  date: r.businessDate,
  customerRef: untrusted('customer_ref', r.customerRef),
  memo: untrusted('memo', r.memo),
});

export const paymentView = (r: Row<typeof rzpPayments>) => ({
  type: 'rzp_payment' as const,
  id: r.id,
  razorpayId: r.rzpId,
  orderId: r.rzpOrderId,
  receipt: r.receipt === null ? null : identifier(r.receipt),
  amountPaise: str(r.amountPaise),
  feePaise: str(r.feePaise),
  taxPaise: str(r.taxPaise),
  amountRefundedPaise: str(r.amountRefundedPaise),
  method: r.method,
  status: r.status,
  captured: r.captured,
  createdAt: iso(r.rzpCreatedAt),
  date: r.businessDate,
});

export const refundView = (r: Row<typeof rzpRefunds>) => ({
  type: 'rzp_refund' as const,
  id: r.id,
  razorpayId: r.rzpId,
  paymentRazorpayId: r.rzpPaymentId,
  amountPaise: str(r.amountPaise),
  status: r.status,
  createdAt: iso(r.rzpCreatedAt),
  date: r.businessDate,
});

export const settlementView = (r: Row<typeof rzpSettlements>) => ({
  type: 'rzp_settlement' as const,
  id: r.id,
  razorpayId: r.rzpId,
  amountPaise: str(r.amountPaise),
  utr: r.utr,
  status: r.status,
  createdAt: iso(r.rzpCreatedAt),
  date: r.businessDate,
});

export const bankView = (r: Row<typeof bankLines>) => ({
  type: 'bank_line' as const,
  id: r.id,
  row: r.sourceRef,
  date: r.valueDate,
  direction: r.direction,
  amountPaise: str(r.amountPaise),
  utr: r.utr,
  utrQuality: r.utrQuality,
  narration: untrusted('narration', r.narration),
});

export const groupView = (g: GroupInfo | undefined) =>
  g === undefined
    ? null
    : {
        groupId: g.groupId,
        kind: g.kind,
        status: g.status,
        tier: g.tier,
        ruleId: g.ruleId,
        reasonCode: g.reasonCode,
        members: g.members.map((m) => ({ type: m.recordType, id: m.recordId })),
      };

export const refOf = (type: RecordType, id: string): RecordRef => ({
  recordType: type,
  recordId: id,
});

/** One line per record: enough to recognise it and compare amounts, not the whole row. */
export interface Brief {
  readonly type: RecordType;
  readonly id: string;
  readonly key: string;
  readonly amountPaise: string;
  readonly date: string | null;
  readonly note?: string;
}

/** A short description of each referenced record (in the order given); records not in the run are omitted. */
export async function briefRefs(
  tx: Executor,
  runId: string,
  refs: readonly RecordRef[],
): Promise<Brief[]> {
  const ids = (type: RecordType) =>
    refs.filter((r) => r.recordType === type).map((r) => r.recordId);
  const found = new Map<string, Brief>();
  const put = (b: Brief) => found.set(`${b.type}:${b.id}`, b);

  if (ids('ledger_entry').length > 0) {
    const rows = await tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.runId, runId), inArray(ledgerEntries.id, ids('ledger_entry'))));
    for (const r of rows) {
      put({
        type: 'ledger_entry',
        id: r.id,
        key: identifier(r.orderRef),
        amountPaise: str(r.amountPaise),
        date: r.businessDate,
      });
    }
  }
  if (ids('rzp_payment').length > 0) {
    const rows = await tx
      .select()
      .from(rzpPayments)
      .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.id, ids('rzp_payment'))));
    for (const r of rows) {
      put({
        type: 'rzp_payment',
        id: r.id,
        key: r.rzpId,
        amountPaise: str(r.amountPaise),
        date: r.businessDate,
        note: `${r.status}, receipt ${r.receipt === null ? 'none' : identifier(r.receipt)}`,
      });
    }
  }
  if (ids('rzp_refund').length > 0) {
    const rows = await tx
      .select()
      .from(rzpRefunds)
      .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.id, ids('rzp_refund'))));
    for (const r of rows) {
      put({
        type: 'rzp_refund',
        id: r.id,
        key: r.rzpId,
        amountPaise: str(r.amountPaise),
        date: r.businessDate,
        note: `refund of ${r.rzpPaymentId}`,
      });
    }
  }
  if (ids('rzp_settlement').length > 0) {
    const rows = await tx
      .select()
      .from(rzpSettlements)
      .where(
        and(eq(rzpSettlements.runId, runId), inArray(rzpSettlements.id, ids('rzp_settlement'))),
      );
    for (const r of rows) {
      put({
        type: 'rzp_settlement',
        id: r.id,
        key: r.rzpId,
        amountPaise: str(r.amountPaise),
        date: r.businessDate,
        note: `UTR ${r.utr ?? 'none'}`,
      });
    }
  }
  if (ids('bank_line').length > 0) {
    const rows = await tx
      .select()
      .from(bankLines)
      .where(and(eq(bankLines.runId, runId), inArray(bankLines.id, ids('bank_line'))));
    for (const r of rows) {
      put({
        type: 'bank_line',
        id: r.id,
        key: r.sourceRef,
        amountPaise: str(r.amountPaise),
        date: r.valueDate,
        note: `${r.direction}, UTR ${r.utr ?? 'none'}${r.utrQuality ? ` (${r.utrQuality})` : ''}`,
      });
    }
  }
  return refs.flatMap((ref) => {
    const brief = found.get(`${ref.recordType}:${ref.recordId}`);
    return brief ? [brief] : [];
  });
}
