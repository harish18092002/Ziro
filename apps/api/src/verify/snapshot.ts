// Loads exactly the records a proposal touches, as the pure verifier wants them. Records are fetched
// BY ID WITHOUT a run filter on purpose: a link into another run must be found and reported as "belongs
// to a different run", not silently look like a record that does not exist. The run filter lives in the
// verifier, where it is tested; the only run-scoped reads here are the lookups for a settlement's lines,
// which belong to the run being verified.
import { type RecordRef, recordRefSchema } from '@ziro/core/domain';
import { itemPaymentId } from '@ziro/core/matcher';
import type { VerifierSnapshot } from '@ziro/core/verify';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import {
  bankLines,
  ledgerEntries,
  matchLinks,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import {
  bankLineOf,
  itemOf,
  ledgerOf,
  paymentOf,
  refundOf,
  settlementOf,
} from '../recon/records.js';

const idsOf = (links: readonly RecordRef[], type: RecordRef['recordType']): string[] =>
  links.filter((l) => l.recordType === type).map((l) => l.recordId);

const byId = <T extends { id: string }>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((r) => [r.id, r]));

/** The links of a stored proposal, or null if what is stored is not a list of record references. */
export function linksOf(stored: unknown): RecordRef[] | null {
  const parsed = recordRefSchema.array().safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export async function loadSnapshot(
  tx: Executor,
  runId: string,
  links: readonly RecordRef[],
): Promise<VerifierSnapshot> {
  const ledgerIds = idsOf(links, 'ledger_entry');
  const paymentIds = idsOf(links, 'rzp_payment');
  const refundIds = idsOf(links, 'rzp_refund');
  const settlementIds = idsOf(links, 'rzp_settlement');
  const bankIds = idsOf(links, 'bank_line');

  const [ledgerRows, paymentRows, refundRows, settlementRows, bankRows] = await Promise.all([
    ledgerIds.length
      ? tx.select().from(ledgerEntries).where(inArray(ledgerEntries.id, ledgerIds))
      : [],
    paymentIds.length
      ? tx.select().from(rzpPayments).where(inArray(rzpPayments.id, paymentIds))
      : [],
    refundIds.length ? tx.select().from(rzpRefunds).where(inArray(rzpRefunds.id, refundIds)) : [],
    settlementIds.length
      ? tx.select().from(rzpSettlements).where(inArray(rzpSettlements.id, settlementIds))
      : [],
    bankIds.length ? tx.select().from(bankLines).where(inArray(bankLines.id, bankIds)) : [],
  ]);

  // Lines of each linked settlement, and the payments and refunds they name (this run's only).
  const itemRows = settlementRows.length
    ? await tx
        .select()
        .from(settlementItems)
        .where(
          inArray(
            settlementItems.settlementId,
            settlementRows.map((s) => s.id),
          ),
        )
    : [];
  const rzpIdOf = new Map(settlementRows.map((s) => [s.id, s.rzpId]));
  const items = itemRows.map((r) => itemOf(r, rzpIdOf.get(r.settlementId) ?? ''));
  const settlementItemsByRzpId = new Map<string, typeof items>();
  for (const item of items) {
    settlementItemsByRzpId.set(item.settlementId, [
      ...(settlementItemsByRzpId.get(item.settlementId) ?? []),
      item,
    ]);
  }
  const namedPayments = [
    ...new Set(
      items.filter((i) => i.itemType === 'payment').map((i) => itemPaymentId(i) ?? i.entityId),
    ),
  ];
  const namedRefunds = [
    ...new Set(items.filter((i) => i.itemType === 'refund').map((i) => i.entityId)),
  ];
  const [linePayments, lineRefunds] = await Promise.all([
    namedPayments.length
      ? tx
          .select()
          .from(rzpPayments)
          .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.rzpId, namedPayments)))
      : [],
    namedRefunds.length
      ? tx
          .select()
          .from(rzpRefunds)
          .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.rzpId, namedRefunds)))
      : [],
  ]);

  // Which of these records are already in an ACCEPTED group, in any run.
  const taken = new Set<string>();
  const conditions = [
    ledgerIds.length ? inArray(matchLinks.ledgerEntryId, ledgerIds) : undefined,
    paymentIds.length ? inArray(matchLinks.paymentId, paymentIds) : undefined,
    refundIds.length ? inArray(matchLinks.refundId, refundIds) : undefined,
    settlementIds.length ? inArray(matchLinks.settlementId, settlementIds) : undefined,
    bankIds.length ? inArray(matchLinks.bankLineId, bankIds) : undefined,
  ];
  if (conditions.some((c) => c !== undefined)) {
    const rows = await tx
      .select()
      .from(matchLinks)
      .where(and(eq(matchLinks.groupStatus, 'accepted'), or(...conditions)));
    for (const row of rows) {
      if (row.ledgerEntryId) taken.add(`ledger_entry:${row.ledgerEntryId}`);
      if (row.paymentId) taken.add(`rzp_payment:${row.paymentId}`);
      if (row.refundId) taken.add(`rzp_refund:${row.refundId}`);
      if (row.settlementId) taken.add(`rzp_settlement:${row.settlementId}`);
      if (row.bankLineId) taken.add(`bank_line:${row.bankLineId}`);
    }
  }

  const payments = paymentRows.map(paymentOf);
  const refunds = refundRows.map(refundOf);
  return {
    runId,
    ledger: byId(ledgerRows.map(ledgerOf)),
    payments: byId(payments),
    refunds: byId(refunds),
    settlements: byId(settlementRows.map(settlementOf)),
    bankLines: byId(bankRows.map(bankLineOf)),
    settlementItems: settlementItemsByRzpId,
    paymentsByRzpId: new Map(
      [...payments, ...linePayments.map(paymentOf)].map((p) => [p.paymentId, p]),
    ),
    refundsByRzpId: new Map([...refunds, ...lineRefunds.map(refundOf)].map((r) => [r.refundId, r])),
    accepted: taken,
  };
}
