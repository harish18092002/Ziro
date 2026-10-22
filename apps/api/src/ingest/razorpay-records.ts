// Persists a fetched Razorpay bundle: payments, then refunds, settlements and settlement items,
// resolving each foreign key to our own row id. Everything runs on the caller's transaction.
import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';
import { itemPaymentId } from '@ziro/core/matcher';
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import { rzpPayments, rzpRefunds, rzpSettlements, settlementItems } from '../db/schema.js';
import type { RazorpayBundle } from './razorpay-bundle.js';
import type { RowError } from './report.js';
import { chunks, type ExistingRef, writeSourceRows } from './write.js';

export const ENTITY_KEYS = ['payments', 'refunds', 'settlements', 'settlementItems'] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

export interface EntityCounts {
  readonly fetched: number;
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly rejected: number;
}

export interface BundleOutcome {
  readonly entities: Readonly<Record<EntityKey, EntityCounts>>;
  readonly errors: readonly RowError[];
}

const ID_CHUNK = 5000;

/** The raw payload as stored: always a JSON object, whatever the source handed over. */
function rawObject(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : { value: raw };
}

function assertRun<T extends { runId: string; sourceRef: string }>(runId: string, record: T): void {
  if (record.runId !== runId) {
    throw new Error(`record ${record.sourceRef} belongs to run ${record.runId}, not ${runId}`);
  }
}

type IdLookup = (ids: string[]) => Promise<readonly { rzpId: string; id: string }[]>;

async function idMap(lookup: IdLookup, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  const found = new Map<string, string>();
  for (const batch of chunks(wanted, ID_CHUNK)) {
    for (const row of await lookup(batch)) found.set(row.rzpId, row.id);
  }
  return found;
}

interface Numbered {
  readonly row: number;
  readonly sourceRef: string;
  readonly importHash: string;
}

/** Counts and conflict errors for one entity, whichever table it went into. */
async function writeEntity<R extends Numbered>(
  entity: EntityKey,
  rows: readonly R[],
  rejected: number,
  io: {
    lookup: (refs: string[]) => Promise<readonly ExistingRef[]>;
    insert: (rows: R[]) => Promise<readonly string[]>;
  },
  errors: RowError[],
): Promise<EntityCounts> {
  const outcome = await writeSourceRows({ rows, ...io });
  const rowOf = new Map(rows.map((r) => [r.sourceRef, r.row]));
  for (const sourceRef of outcome.conflicts) {
    errors.push({
      row: rowOf.get(sourceRef) ?? 0,
      line: null,
      field: entity,
      code: 'conflict',
      reason: `${sourceRef} was already imported with different content; imported rows are never overwritten`,
    });
  }
  return {
    fetched: rows.length + rejected,
    inserted: outcome.inserted,
    unchanged: outcome.unchanged,
    conflicts: outcome.conflicts.length,
    rejected,
  };
}

export async function writeBundle(
  tx: Executor,
  runId: string,
  bundle: RazorpayBundle,
): Promise<BundleOutcome> {
  const errors: RowError[] = [];

  // --- payments ---
  const paymentRows = bundle.payments.map((s, i) => {
    const p: RzpPayment = s.record;
    assertRun(runId, p);
    return {
      row: i + 1,
      id: p.id,
      runId,
      source: p.source,
      sourceRef: p.sourceRef,
      importHash: p.importHash,
      raw: rawObject(s.raw),
      rzpId: p.paymentId,
      rzpOrderId: p.orderId,
      receipt: p.receipt,
      amountPaise: p.amount,
      feePaise: p.fee,
      taxPaise: p.tax,
      amountRefundedPaise: p.amountRefunded,
      method: p.method,
      status: p.status,
      captured: p.captured,
      rzpCreatedAt: new Date(p.createdAt),
      businessDate: p.businessDate,
    };
  });
  const payments = await writeEntity(
    'payments',
    paymentRows,
    0,
    {
      lookup: (refs) =>
        tx
          .select({ sourceRef: rzpPayments.sourceRef, importHash: rzpPayments.importHash })
          .from(rzpPayments)
          .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.sourceRef, refs))),
      insert: async (rows) =>
        (
          await tx
            .insert(rzpPayments)
            .values(rows.map(({ row: _row, ...values }) => values))
            .onConflictDoNothing({ target: [rzpPayments.runId, rzpPayments.sourceRef] })
            .returning({ sourceRef: rzpPayments.sourceRef })
        ).map((r) => r.sourceRef),
    },
    errors,
  );

  const paymentIds = await idMap(
    (ids) =>
      tx
        .select({ rzpId: rzpPayments.rzpId, id: rzpPayments.id })
        .from(rzpPayments)
        .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.rzpId, ids))),
    [
      ...bundle.refunds.map((s) => s.record.paymentId),
      ...bundle.items.map((s) => itemPaymentId(s.record)),
    ],
  );

  // --- refunds ---
  const refundRows = bundle.refunds.map((s, i) => {
    const r: RzpRefund = s.record;
    assertRun(runId, r);
    return {
      row: i + 1,
      id: r.id,
      runId,
      source: r.source,
      sourceRef: r.sourceRef,
      importHash: r.importHash,
      raw: rawObject(s.raw),
      rzpId: r.refundId,
      rzpPaymentId: r.paymentId,
      paymentId: paymentIds.get(r.paymentId) ?? null,
      amountPaise: r.amount,
      status: r.status,
      rzpCreatedAt: new Date(r.createdAt),
      businessDate: r.businessDate,
    };
  });
  const refunds = await writeEntity(
    'refunds',
    refundRows,
    0,
    {
      lookup: (refs) =>
        tx
          .select({ sourceRef: rzpRefunds.sourceRef, importHash: rzpRefunds.importHash })
          .from(rzpRefunds)
          .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.sourceRef, refs))),
      insert: async (rows) =>
        (
          await tx
            .insert(rzpRefunds)
            .values(rows.map(({ row: _row, ...values }) => values))
            .onConflictDoNothing({ target: [rzpRefunds.runId, rzpRefunds.sourceRef] })
            .returning({ sourceRef: rzpRefunds.sourceRef })
        ).map((r) => r.sourceRef),
    },
    errors,
  );

  // --- settlements ---
  const settlementRows = bundle.settlements.map((s, i) => {
    const st: RzpSettlement = s.record;
    assertRun(runId, st);
    return {
      row: i + 1,
      id: st.id,
      runId,
      source: st.source,
      sourceRef: st.sourceRef,
      importHash: st.importHash,
      raw: rawObject(s.raw),
      rzpId: st.settlementId,
      amountPaise: st.amount,
      feesPaise: st.fees,
      taxPaise: st.tax,
      utr: st.utr,
      status: st.status,
      rzpCreatedAt: new Date(st.createdAt),
      businessDate: st.businessDate,
    };
  });
  const settlements = await writeEntity(
    'settlements',
    settlementRows,
    0,
    {
      lookup: (refs) =>
        tx
          .select({ sourceRef: rzpSettlements.sourceRef, importHash: rzpSettlements.importHash })
          .from(rzpSettlements)
          .where(and(eq(rzpSettlements.runId, runId), inArray(rzpSettlements.sourceRef, refs))),
      insert: async (rows) =>
        (
          await tx
            .insert(rzpSettlements)
            .values(rows.map(({ row: _row, ...values }) => values))
            .onConflictDoNothing({ target: [rzpSettlements.runId, rzpSettlements.sourceRef] })
            .returning({ sourceRef: rzpSettlements.sourceRef })
        ).map((r) => r.sourceRef),
    },
    errors,
  );

  // --- settlement items: need the settlement (required) and, where known, payment/refund rows ---
  const settlementIds = await idMap(
    (ids) =>
      tx
        .select({ rzpId: rzpSettlements.rzpId, id: rzpSettlements.id })
        .from(rzpSettlements)
        .where(and(eq(rzpSettlements.runId, runId), inArray(rzpSettlements.rzpId, ids))),
    bundle.items.map((s) => s.record.settlementId),
  );
  const refundIds = await idMap(
    (ids) =>
      tx
        .select({ rzpId: rzpRefunds.rzpId, id: rzpRefunds.id })
        .from(rzpRefunds)
        .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.rzpId, ids))),
    bundle.items.filter((s) => s.record.itemType === 'refund').map((s) => s.record.entityId),
  );

  let orphans = 0;
  const itemRows: (Numbered & Record<string, unknown>)[] = [];
  bundle.items.forEach((s, i) => {
    const it: SettlementItem = s.record;
    assertRun(runId, it);
    const settlementId = settlementIds.get(it.settlementId);
    if (settlementId === undefined) {
      orphans += 1;
      errors.push({
        row: i + 1,
        line: null,
        field: 'settlementId',
        code: 'unknown_settlement',
        reason: `item ${it.sourceRef} belongs to ${it.settlementId}, which is not among this run's settlements`,
      });
      return;
    }
    itemRows.push({
      row: i + 1,
      id: it.id,
      runId,
      source: it.source,
      sourceRef: it.sourceRef,
      importHash: it.importHash,
      raw: rawObject(s.raw),
      settlementId,
      itemType: it.itemType,
      rzpEntityId: it.entityId,
      rzpPaymentId: itemPaymentId(it),
      rzpOrderId: it.orderId,
      paymentId: paymentIds.get(itemPaymentId(it) ?? '') ?? null,
      refundId: it.itemType === 'refund' ? (refundIds.get(it.entityId) ?? null) : null,
      amountPaise: it.amount,
      feePaise: it.fee,
      taxPaise: it.tax,
      debitPaise: it.debit,
      creditPaise: it.credit,
      settledAt: it.settledAt === null ? null : new Date(it.settledAt),
      description: it.description,
    });
  });
  const settlementItemCounts = await writeEntity(
    'settlementItems',
    itemRows,
    orphans,
    {
      lookup: (refs) =>
        tx
          .select({ sourceRef: settlementItems.sourceRef, importHash: settlementItems.importHash })
          .from(settlementItems)
          .where(and(eq(settlementItems.runId, runId), inArray(settlementItems.sourceRef, refs))),
      insert: async (rows) =>
        (
          await tx
            .insert(settlementItems)
            .values(
              rows.map(({ row: _row, ...values }) => values as typeof settlementItems.$inferInsert),
            )
            .onConflictDoNothing({ target: [settlementItems.runId, settlementItems.sourceRef] })
            .returning({ sourceRef: settlementItems.sourceRef })
        ).map((r) => r.sourceRef),
    },
    errors,
  );

  return {
    entities: { payments, refunds, settlements, settlementItems: settlementItemCounts },
    errors,
  };
}
