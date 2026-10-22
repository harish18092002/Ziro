// Read-only queries behind the agent's tools. Every function takes `runId` and puts it in the WHERE
// clause of every table it touches, so none of them can see another run's records. They are only
// ever called with a READ ONLY transaction (see toolbox.ts); a write would be refused by Postgres.
import type { RecordRef, RecordType } from '@ziro/core/domain';
import { normalizeRef } from '@ziro/core/normalize';
import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { Executor } from '../../db/executor.js';
import {
  bankLines,
  ledgerEntries,
  matchGroups,
  matchLinks,
  reconExceptions,
  reconRuns,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../../db/schema.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Executor;

export async function runConfigOf(tx: Tx, runId: string): Promise<unknown> {
  const [row] = await tx
    .select({ config: reconRuns.config })
    .from(reconRuns)
    .where(eq(reconRuns.id, runId));
  return row?.config ?? null;
}

export async function getException(tx: Tx, runId: string, id: string) {
  const [row] = await tx
    .select()
    .from(reconExceptions)
    .where(and(eq(reconExceptions.runId, runId), eq(reconExceptions.id, id)));
  return row;
}

export async function getLedger(tx: Tx, runId: string, key: string) {
  const k = key.trim();
  const byKey = UUID.test(k)
    ? eq(ledgerEntries.id, k.toLowerCase())
    : eq(ledgerEntries.orderRef, normalizeRef(k) ?? k);
  return tx
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.runId, runId), byKey))
    .limit(5);
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

export interface LedgerFilter {
  readonly amountMin?: bigint;
  readonly amountMax?: bigint;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly text?: string;
  readonly limit: number;
}

export async function searchLedger(tx: Tx, runId: string, f: LedgerFilter) {
  const where = [eq(ledgerEntries.runId, runId)];
  if (f.amountMin !== undefined) where.push(gte(ledgerEntries.amountPaise, f.amountMin));
  if (f.amountMax !== undefined) where.push(lte(ledgerEntries.amountPaise, f.amountMax));
  if (f.dateFrom !== undefined) where.push(gte(ledgerEntries.businessDate, f.dateFrom));
  if (f.dateTo !== undefined) where.push(lte(ledgerEntries.businessDate, f.dateTo));
  if (f.text !== undefined) {
    const like = `%${escapeLike(f.text)}%`;
    const text = or(
      ilike(ledgerEntries.orderRef, like),
      ilike(ledgerEntries.customerRef, like),
      ilike(ledgerEntries.memo, like),
    );
    if (text) where.push(text);
  }
  // One extra row tells the caller whether the answer was cut short.
  return tx
    .select()
    .from(ledgerEntries)
    .where(and(...where))
    .orderBy(asc(ledgerEntries.businessDate), asc(ledgerEntries.id))
    .limit(f.limit + 1);
}

export async function getPayments(tx: Tx, runId: string, key: string) {
  const k = key.trim();
  const byKey = UUID.test(k)
    ? eq(rzpPayments.id, k.toLowerCase())
    : /^pay_/i.test(k)
      ? eq(rzpPayments.rzpId, k)
      : sql`upper(${rzpPayments.receipt}) = ${normalizeRef(k) ?? k}`;
  return tx
    .select()
    .from(rzpPayments)
    .where(and(eq(rzpPayments.runId, runId), byKey))
    .orderBy(asc(rzpPayments.rzpCreatedAt), asc(rzpPayments.id))
    .limit(5);
}

/** The settlement each payment was paid out in, by its recon line. */
export async function settlementsOfPayments(tx: Tx, runId: string, paymentIds: string[]) {
  if (paymentIds.length === 0) return [];
  return tx
    .select({
      paymentId: settlementItems.paymentId,
      id: rzpSettlements.id,
      rzpId: rzpSettlements.rzpId,
      amountPaise: rzpSettlements.amountPaise,
      businessDate: rzpSettlements.businessDate,
    })
    .from(settlementItems)
    .innerJoin(rzpSettlements, eq(settlementItems.settlementId, rzpSettlements.id))
    .where(
      and(
        eq(settlementItems.runId, runId),
        eq(settlementItems.itemType, 'payment'),
        inArray(settlementItems.paymentId, paymentIds),
      ),
    );
}

export async function refundsOfPayment(tx: Tx, runId: string, paymentRzpId: string) {
  return tx
    .select()
    .from(rzpRefunds)
    .where(and(eq(rzpRefunds.runId, runId), eq(rzpRefunds.rzpPaymentId, paymentRzpId)))
    .orderBy(asc(rzpRefunds.rzpCreatedAt), asc(rzpRefunds.id))
    .limit(20);
}

export async function getSettlement(tx: Tx, runId: string, key: string) {
  const k = key.trim();
  const byKey = UUID.test(k) ? eq(rzpSettlements.id, k.toLowerCase()) : eq(rzpSettlements.rzpId, k);
  const [row] = await tx
    .select()
    .from(rzpSettlements)
    .where(and(eq(rzpSettlements.runId, runId), byKey));
  return row;
}

export async function itemsOfSettlement(tx: Tx, runId: string, settlementId: string) {
  return tx
    .select()
    .from(settlementItems)
    .where(and(eq(settlementItems.runId, runId), eq(settlementItems.settlementId, settlementId)))
    .orderBy(asc(settlementItems.rzpEntityId), asc(settlementItems.sourceRef));
}

export interface BankFilter {
  readonly amountMin?: bigint;
  readonly amountMax?: bigint;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly utrFragment?: string;
  readonly direction?: 'credit' | 'debit';
  readonly limit: number;
}

export async function searchBank(tx: Tx, runId: string, f: BankFilter) {
  const where = [eq(bankLines.runId, runId)];
  if (f.amountMin !== undefined) where.push(gte(bankLines.amountPaise, f.amountMin));
  if (f.amountMax !== undefined) where.push(lte(bankLines.amountPaise, f.amountMax));
  if (f.dateFrom !== undefined) where.push(gte(bankLines.valueDate, f.dateFrom));
  if (f.dateTo !== undefined) where.push(lte(bankLines.valueDate, f.dateTo));
  if (f.direction !== undefined) where.push(eq(bankLines.direction, f.direction));
  if (f.utrFragment !== undefined) {
    const like = `%${escapeLike(f.utrFragment)}%`;
    const text = or(ilike(bankLines.utr, like), ilike(bankLines.narration, like));
    if (text) where.push(text);
  }
  return tx
    .select()
    .from(bankLines)
    .where(and(...where))
    .orderBy(asc(bankLines.valueDate), asc(bankLines.id))
    .limit(f.limit + 1);
}

// --- records named by the model for compute_expected_settlement ---------------------------------

const split = (keys: readonly string[]) => ({
  uuids: keys.filter((k) => UUID.test(k)).map((k) => k.toLowerCase()),
  names: keys.filter((k) => !UUID.test(k)),
});

export async function paymentsByKeys(tx: Tx, runId: string, keys: readonly string[]) {
  const { uuids, names } = split(keys);
  const match = or(
    uuids.length ? inArray(rzpPayments.id, uuids) : undefined,
    names.length ? inArray(rzpPayments.rzpId, names) : undefined,
  );
  if (!match) return [];
  return tx
    .select()
    .from(rzpPayments)
    .where(and(eq(rzpPayments.runId, runId), match));
}

export async function refundsByKeys(tx: Tx, runId: string, keys: readonly string[]) {
  const { uuids, names } = split(keys);
  const match = or(
    uuids.length ? inArray(rzpRefunds.id, uuids) : undefined,
    names.length ? inArray(rzpRefunds.rzpId, names) : undefined,
  );
  if (!match) return [];
  return tx
    .select()
    .from(rzpRefunds)
    .where(and(eq(rzpRefunds.runId, runId), match));
}

/** Adjustment and transfer lines of any settlement, by line id or by Razorpay's adjustment id. */
export async function adjustmentsByKeys(tx: Tx, runId: string, keys: readonly string[]) {
  const { uuids, names } = split(keys);
  const match = or(
    uuids.length ? inArray(settlementItems.id, uuids) : undefined,
    names.length ? inArray(settlementItems.rzpEntityId, names) : undefined,
  );
  if (!match) return [];
  return tx
    .select()
    .from(settlementItems)
    .where(
      and(
        eq(settlementItems.runId, runId),
        inArray(settlementItems.itemType, ['adjustment', 'transfer']),
        match,
      ),
    );
}

/** Payment and refund rows by Razorpay id, for cross-checking a settlement's lines. */
export async function paymentsByRzpIds(tx: Tx, runId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(rzpPayments)
    .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.rzpId, [...ids])));
}

export async function refundsByRzpIds(tx: Tx, runId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(rzpRefunds)
    .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.rzpId, [...ids])));
}

// --- what the rules did with a record --------------------------------------------------------------

const LINK_COLUMN = {
  ledger_entry: matchLinks.ledgerEntryId,
  rzp_payment: matchLinks.paymentId,
  rzp_refund: matchLinks.refundId,
  rzp_settlement: matchLinks.settlementId,
  bank_line: matchLinks.bankLineId,
} as const;

export interface GroupInfo {
  readonly groupId: string;
  readonly kind: string;
  readonly status: string;
  readonly tier: string | null;
  readonly ruleId: string | null;
  readonly reasonCode: string | null;
  readonly members: RecordRef[];
}

/** The match group each of these records belongs to, if any, with the group's other members. */
export async function groupsOf(
  tx: Tx,
  runId: string,
  type: RecordType,
  ids: readonly string[],
): Promise<Map<string, GroupInfo>> {
  const found = new Map<string, GroupInfo>();
  if (ids.length === 0) return found;
  const column = LINK_COLUMN[type];
  const own = await tx
    .select({
      recordId: column,
      groupId: matchGroups.id,
      kind: matchGroups.kind,
      status: matchGroups.status,
      tier: matchGroups.tier,
      ruleId: matchGroups.ruleId,
      reasonCode: matchGroups.reasonCode,
    })
    .from(matchLinks)
    .innerJoin(matchGroups, eq(matchLinks.groupId, matchGroups.id))
    .where(and(eq(matchGroups.runId, runId), inArray(column, [...ids])));
  if (own.length === 0) return found;

  const all = await tx
    .select({
      groupId: matchLinks.groupId,
      ledger: matchLinks.ledgerEntryId,
      payment: matchLinks.paymentId,
      refund: matchLinks.refundId,
      settlement: matchLinks.settlementId,
      bank: matchLinks.bankLineId,
    })
    .from(matchLinks)
    .where(inArray(matchLinks.groupId, [...new Set(own.map((g) => g.groupId))]));
  const members = new Map<string, RecordRef[]>();
  for (const link of all) {
    const ref: RecordRef | null = link.ledger
      ? { recordType: 'ledger_entry', recordId: link.ledger }
      : link.payment
        ? { recordType: 'rzp_payment', recordId: link.payment }
        : link.refund
          ? { recordType: 'rzp_refund', recordId: link.refund }
          : link.settlement
            ? { recordType: 'rzp_settlement', recordId: link.settlement }
            : link.bank
              ? { recordType: 'bank_line', recordId: link.bank }
              : null;
    if (ref) members.set(link.groupId, [...(members.get(link.groupId) ?? []), ref]);
  }
  for (const g of own) {
    if (g.recordId === null) continue;
    found.set(g.recordId, {
      groupId: g.groupId,
      kind: g.kind,
      status: g.status,
      tier: g.tier,
      ruleId: g.ruleId,
      reasonCode: g.reasonCode,
      members: members.get(g.groupId) ?? [],
    });
  }
  return found;
}
