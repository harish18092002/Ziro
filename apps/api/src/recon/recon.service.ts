// Runs the deterministic matcher over a run's imported rows and keeps what it found: the groups the
// rules could prove (accepted, basis `rule`) and the exceptions they could not settle safely (open, with
// their candidates). Everything goes through the same writers the agent's approvals use, in one
// transaction, so a run is either not matched at all or matched completely.
import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runMatcher } from '@ziro/core/matcher';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type AuditStep, auditSteps } from '../audit/audit.js';
import { verifierConfigOf } from '../common/verifier-config.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import {
  bankLines,
  ledgerEntries,
  reconExceptions,
  reconRuns,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import { writeGroups } from './group-writer.js';
import {
  bankLineOf,
  itemOf,
  ledgerOf,
  paymentOf,
  refundOf,
  settlementOf as settlementRecordOf,
} from './records.js';

export interface MatchResult {
  readonly runId: string;
  readonly groups: number;
  readonly exceptions: number;
  readonly ignored: number;
  /** True when the run had already been matched: nothing was done this time. */
  readonly alreadyMatched: boolean;
}

const EXCEPTIONS_PER_STATEMENT = 400;
/** Candidates named in an exception's audit step; the exception row itself keeps all it has (up to 50). */
const AUDITED_CANDIDATES = 5;

@Injectable()
export class ReconService {
  constructor(@Inject(DB) private readonly db: Executor) {}

  async match(runId: string): Promise<MatchResult> {
    const [run] = await this.db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    if (run === undefined) throw new NotFoundException('no such run');

    // Claim the run. Only one caller gets past this; the rest see a run that is already matched.
    const [claimed] = await this.db
      .update(reconRuns)
      .set({ status: 'matching' })
      .where(and(eq(reconRuns.id, runId), inArray(reconRuns.status, ['created', 'ingesting'])))
      .returning({ id: reconRuns.id });
    if (claimed === undefined) return this.existing(runId, run.status);

    try {
      return await this.db.transaction(async (tx) => {
        const input = await this.load(tx, runId);
        const output = runMatcher(input, verifierConfigOf(run.config).config);

        await writeGroups(
          tx,
          output.groups.map((g) => ({
            runId,
            kind: g.kind,
            status: 'accepted' as const,
            basis: 'rule' as const,
            tier: g.tier,
            ruleId: g.ruleId,
            reasonCode: g.reasonCode,
            residual: g.residual,
            links: g.members,
            actor: 'rule' as const,
            reason: `${g.ruleId} matched ${g.members.length} records exactly`,
          })),
        );

        const rows = output.exceptions.map((e) => ({
          id: randomUUID(),
          runId,
          reasonCode: e.reasonCode,
          status: 'open' as const,
          subjectType: e.subject.recordType,
          subjectId: e.subject.recordId,
          candidates: [...e.candidates],
          amountAtStakePaise: e.amountAtStake,
          cause: e.cause,
          note: e.note,
        }));
        for (let from = 0; from < rows.length; from += EXCEPTIONS_PER_STATEMENT) {
          await tx
            .insert(reconExceptions)
            .values(rows.slice(from, from + EXCEPTIONS_PER_STATEMENT));
        }
        const steps: AuditStep[] = rows.map((row, i) => ({
          runId,
          actor: 'rule',
          action: 'exception.create',
          entity: { type: 'recon_exception', id: row.id },
          before: null,
          after: {
            status: 'open',
            reasonCode: row.reasonCode,
            cause: row.cause,
            candidates: row.candidates.length,
            amountAtStakePaise: row.amountAtStakePaise,
          },
          reason: row.note,
          records: [
            { recordType: row.subjectType, recordId: row.subjectId },
            ...(output.exceptions[i]?.candidates.slice(0, AUDITED_CANDIDATES) ?? []),
          ],
        }));
        await auditSteps(tx, steps);

        const summary = {
          groups: output.groups.length,
          exceptions: output.exceptions.length,
          ignored: output.ignored.length,
          at: new Date().toISOString(),
        };
        await tx
          .update(reconRuns)
          .set({ config: sql`${reconRuns.config} || ${JSON.stringify({ match: summary })}::jsonb` })
          .where(eq(reconRuns.id, runId));
        await auditSteps(tx, [
          {
            runId,
            actor: 'system',
            action: 'run.match',
            entity: { type: 'recon_run', id: runId },
            before: { status: 'ingesting' },
            after: { status: 'matching', ...summary },
            reason: 'the rule matcher ran over the imported records',
          },
        ]);
        return { runId, ...summary, alreadyMatched: false };
      });
    } catch (error) {
      // The transaction rolled back, so nothing was written: hand the run back to be matched again.
      await this.db.update(reconRuns).set({ status: run.status }).where(eq(reconRuns.id, runId));
      throw error;
    }
  }

  private async existing(runId: string, status: string): Promise<MatchResult> {
    if (status === 'failed') {
      throw new ConflictException('this run failed earlier and cannot be matched');
    }
    const [run] = await this.db
      .select({ config: reconRuns.config })
      .from(reconRuns)
      .where(eq(reconRuns.id, runId));
    const match = (
      run?.config as { match?: { groups?: number; exceptions?: number; ignored?: number } } | null
    )?.match;
    if (match === undefined) {
      // Claimed by a call that is still working; say so rather than reporting a result that is not there yet.
      throw new ConflictException('this run is being matched right now');
    }
    return {
      runId,
      groups: match.groups ?? 0,
      exceptions: match.exceptions ?? 0,
      ignored: match.ignored ?? 0,
      alreadyMatched: true,
    };
  }

  /** Every imported record of the run, as the pure matcher wants them. */
  private async load(tx: Executor, runId: string) {
    const [ledger, payments, refunds, settlements, items, bank] = await Promise.all([
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId)),
      tx.select().from(rzpPayments).where(eq(rzpPayments.runId, runId)),
      tx.select().from(rzpRefunds).where(eq(rzpRefunds.runId, runId)),
      tx.select().from(rzpSettlements).where(eq(rzpSettlements.runId, runId)),
      tx.select().from(settlementItems).where(eq(settlementItems.runId, runId)),
      tx.select().from(bankLines).where(eq(bankLines.runId, runId)),
    ]);
    const settlementRzpId = new Map(settlements.map((s) => [s.id, s.rzpId]));
    return {
      ledger: ledger.map(ledgerOf),
      payments: payments.map(paymentOf),
      refunds: refunds.map(refundOf),
      settlements: settlements.map(settlementRecordOf),
      settlementItems: items.map((i) => itemOf(i, settlementRzpId.get(i.settlementId) ?? '')),
      bankLines: bank.map(bankLineOf),
    };
  }
}
