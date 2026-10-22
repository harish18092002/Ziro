import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RecordType } from '@ziro/core/domain';
import { and, asc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import {
  auditEventRecords,
  auditEvents,
  bankLines,
  ledgerEntries,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
} from '../db/schema.js';

/** The longest timeline returned in one response; `truncated` says when there was more. */
export const MAX_TIMELINE_EVENTS = 500;

export interface TimelineEntry {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string };
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly runId: string | null;
}

export interface RecordSummary {
  readonly type: RecordType;
  readonly id: string;
  readonly runId: string;
  /** The record's own key: order reference, Razorpay id, or statement row. */
  readonly key: string;
  readonly amountPaise: string;
  readonly date: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly importHash: string;
  readonly importedAt: string;
}

interface Found {
  readonly type: RecordType;
  readonly row: {
    id: string;
    runId: string;
    sourceRef: string;
    source: string;
    importHash: string;
    createdAt: Date;
  };
  readonly key: string;
  readonly amount: bigint;
  readonly date: string;
}

const isEnvelope = (detail: unknown): detail is Record<string, unknown> =>
  typeof detail === 'object' && detail !== null && 'records' in detail;

@Injectable()
export class TimelineService {
  constructor(@Inject(DB) private readonly db: Executor) {}

  private async find(id: string): Promise<Found | null> {
    const [ledger] = await this.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id));
    if (ledger) {
      return {
        type: 'ledger_entry',
        row: ledger,
        key: ledger.orderRef,
        amount: ledger.amountPaise,
        date: ledger.businessDate,
      };
    }
    const [payment] = await this.db.select().from(rzpPayments).where(eq(rzpPayments.id, id));
    if (payment) {
      return {
        type: 'rzp_payment',
        row: payment,
        key: payment.rzpId,
        amount: payment.amountPaise,
        date: payment.businessDate,
      };
    }
    const [refund] = await this.db.select().from(rzpRefunds).where(eq(rzpRefunds.id, id));
    if (refund) {
      return {
        type: 'rzp_refund',
        row: refund,
        key: refund.rzpId,
        amount: refund.amountPaise,
        date: refund.businessDate,
      };
    }
    const [settlement] = await this.db
      .select()
      .from(rzpSettlements)
      .where(eq(rzpSettlements.id, id));
    if (settlement) {
      return {
        type: 'rzp_settlement',
        row: settlement,
        key: settlement.rzpId,
        amount: settlement.amountPaise,
        date: settlement.businessDate,
      };
    }
    const [bank] = await this.db.select().from(bankLines).where(eq(bankLines.id, id));
    if (bank) {
      return {
        type: 'bank_line',
        row: bank,
        key: bank.sourceRef,
        amount: bank.amountPaise,
        date: bank.valueDate,
      };
    }
    return null;
  }

  /**
   * Everything that ever happened to one source record, oldest first: its import (read from the
   * record itself), then every audit step that named it (proposals, verification, review, groups).
   */
  async timeline(recordId: string): Promise<{
    record: RecordSummary;
    timeline: TimelineEntry[];
    truncated: boolean;
  }> {
    const found = await this.find(recordId);
    if (found === null) throw new NotFoundException('no such record');

    const rows = await this.db
      .select({ event: auditEvents })
      .from(auditEventRecords)
      .innerJoin(auditEvents, eq(auditEvents.id, auditEventRecords.auditEventId))
      .where(
        and(eq(auditEventRecords.recordId, recordId), eq(auditEventRecords.recordType, found.type)),
      )
      .orderBy(asc(auditEvents.id))
      .limit(MAX_TIMELINE_EVENTS + 1);

    const record: RecordSummary = {
      type: found.type,
      id: found.row.id,
      runId: found.row.runId,
      key: found.key,
      amountPaise: found.amount.toString(),
      date: found.date,
      source: found.row.source,
      sourceRef: found.row.sourceRef,
      importHash: found.row.importHash,
      importedAt: found.row.createdAt.toISOString(),
    };
    const imported: TimelineEntry = {
      id: 'import',
      at: record.importedAt,
      actor: 'system',
      action: 'record.imported',
      entity: { type: found.type, id: recordId },
      before: null,
      after: { source: record.source, sourceRef: record.sourceRef, importHash: record.importHash },
      reason: null,
      runId: record.runId,
    };
    const shown = rows.slice(0, MAX_TIMELINE_EVENTS);
    return {
      record,
      timeline: [
        imported,
        ...shown.map(({ event }): TimelineEntry => {
          const d: unknown = event.detail;
          const envelope = isEnvelope(d) ? d : null;
          return {
            id: event.id.toString(),
            at: event.at.toISOString(),
            actor: event.actor,
            action: event.action,
            entity: { type: event.entityType, id: event.entityId },
            before: envelope ? (envelope['before'] ?? null) : null,
            after: envelope ? (envelope['after'] ?? null) : d,
            reason: envelope && typeof envelope['reason'] === 'string' ? envelope['reason'] : null,
            runId: event.runId,
          };
        }),
      ],
      truncated: rows.length > MAX_TIMELINE_EVENTS,
    };
  }
}
