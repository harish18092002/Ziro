// Reads a finished run back out of the database in the terms the scorer uses: truth keys, not row ids.
// Everything here is a read; nothing in the run is changed.
import type { RecordRef } from '@ziro/core/domain';
import type { AcceptedGroup } from '@ziro/evals';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { parseMicroUsd } from '../agent/pricing.js';
import type { Executor } from '../db/executor.js';
import {
  agentProposals,
  bankLines,
  ledgerEntries,
  llmCalls,
  matchGroups,
  matchLinks,
  reconExceptions,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
} from '../db/schema.js';
import type { GapItem } from '../report/gap.js';

/** Row id -> `type:key` as truth.json writes it. */
export async function keyMap(db: Executor, runId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await db
    .select({ id: ledgerEntries.id, k: ledgerEntries.orderRef })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.runId, runId)))
    out.set(r.id, `ledger_entry:${r.k}`);
  for (const r of await db
    .select({ id: rzpPayments.id, k: rzpPayments.rzpId })
    .from(rzpPayments)
    .where(eq(rzpPayments.runId, runId)))
    out.set(r.id, `rzp_payment:${r.k}`);
  for (const r of await db
    .select({ id: rzpRefunds.id, k: rzpRefunds.rzpId })
    .from(rzpRefunds)
    .where(eq(rzpRefunds.runId, runId)))
    out.set(r.id, `rzp_refund:${r.k}`);
  for (const r of await db
    .select({ id: rzpSettlements.id, k: rzpSettlements.rzpId })
    .from(rzpSettlements)
    .where(eq(rzpSettlements.runId, runId)))
    out.set(r.id, `rzp_settlement:${r.k}`);
  for (const r of await db
    .select({ id: bankLines.id, k: bankLines.sourceRef })
    .from(bankLines)
    .where(eq(bankLines.runId, runId)))
    out.set(r.id, `bank_line:${r.k}`);
  return out;
}

/** Every accepted group, from the rules or from an approved agent proposal, as truth keys. */
export async function acceptedGroups(
  db: Executor,
  runId: string,
  keys: ReadonlyMap<string, string>,
): Promise<AcceptedGroup[]> {
  const rows = await db
    .select({
      groupId: matchGroups.id,
      kind: matchGroups.kind,
      basis: matchGroups.basis,
      ledger: matchLinks.ledgerEntryId,
      payment: matchLinks.paymentId,
      refund: matchLinks.refundId,
      settlement: matchLinks.settlementId,
      bank: matchLinks.bankLineId,
    })
    .from(matchLinks)
    .innerJoin(matchGroups, eq(matchGroups.id, matchLinks.groupId))
    .where(and(eq(matchGroups.runId, runId), eq(matchGroups.status, 'accepted')))
    .orderBy(asc(matchGroups.id));

  const groups = new Map<string, AcceptedGroup & { keys: string[] }>();
  for (const r of rows) {
    const group = groups.get(r.groupId) ?? {
      id: r.groupId,
      origin: r.basis === 'rule' ? ('rule' as const) : ('agent' as const),
      kind: r.kind,
      keys: [],
    };
    groups.set(r.groupId, group);
    for (const id of [r.ledger, r.payment, r.refund, r.settlement, r.bank]) {
      const key = id === null ? undefined : keys.get(id);
      if (key !== undefined) group.keys.push(key);
    }
  }
  return [...groups.values()];
}

export interface ExceptionFact extends GapItem {
  readonly id: string;
  readonly subjectKey: string;
  readonly cause: string | null;
  readonly ruleReasonCode: string;
}

export async function exceptionFacts(
  db: Executor,
  runId: string,
  keys: ReadonlyMap<string, string>,
): Promise<ExceptionFact[]> {
  const rows = await db
    .select()
    .from(reconExceptions)
    .where(eq(reconExceptions.runId, runId))
    .orderBy(asc(reconExceptions.id));
  return rows.map((e) => ({
    id: e.id,
    status: e.status,
    stakePaise: e.amountAtStakePaise,
    records: [
      e.subjectId,
      ...(Array.isArray(e.candidates) ? (e.candidates as RecordRef[]).map((c) => c.recordId) : []),
    ],
    subjectKey: keys.get(e.subjectId) ?? e.subjectId,
    cause: e.cause,
    ruleReasonCode: e.reasonCode,
  }));
}

export interface ProposalFact {
  readonly proposalId: string;
  readonly exceptionId: string;
  readonly subjectKey: string;
  readonly verdict: string;
  readonly reasonCode: string;
  readonly suggestedAction: string;
  readonly explanation: string;
  readonly evidenceText: string;
  readonly verifierStatus: string;
  readonly verifierFindings: string[];
  /** Truth keys of the records the proposal links. */
  readonly linkKeys: string[];
  readonly model: string | null;
}

/** The newest proposal for each exception. */
export async function latestProposals(
  db: Executor,
  runId: string,
  facts: readonly ExceptionFact[],
  keys: ReadonlyMap<string, string>,
): Promise<ProposalFact[]> {
  const subjectOf = new Map(facts.map((f) => [f.id, f.subjectKey]));
  const rows = await db
    .select()
    .from(agentProposals)
    .where(eq(agentProposals.runId, runId))
    .orderBy(asc(agentProposals.attempt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.exceptionId, r);
  return [...latest.values()]
    .map((p) => ({
      proposalId: p.id,
      exceptionId: p.exceptionId,
      subjectKey: subjectOf.get(p.exceptionId) ?? p.exceptionId,
      verdict: p.verdict,
      reasonCode: p.reasonCode,
      suggestedAction: p.suggestedAction,
      explanation: p.explanation,
      evidenceText: (Array.isArray(p.evidence) ? (p.evidence as { keyFinding?: string }[]) : [])
        .map((e) => e.keyFinding ?? '')
        .join('\n'),
      verifierStatus: p.verifierStatus,
      verifierFindings: Array.isArray(p.verifierFindings) ? p.verifierFindings : [],
      linkKeys: (Array.isArray(p.links) ? (p.links as RecordRef[]) : [])
        .map((l) => keys.get(l.recordId))
        .filter((k): k is string => k !== undefined),
      model: p.model,
    }))
    .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0));
}

export interface LlmTotals {
  readonly calls: number;
  readonly costMicroUsd: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export async function llmTotals(db: Executor, runId: string): Promise<LlmTotals> {
  const [row] = await db
    .select({
      calls: count(),
      cost: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text`,
      input: sql<number>`coalesce(sum(${llmCalls.tokensIn}), 0)::int`,
      output: sql<number>`coalesce(sum(${llmCalls.tokensOut}), 0)::int`,
      cacheRead: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)::int`,
      cacheWrite: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)::int`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.runId, runId));
  return {
    calls: row?.calls ?? 0,
    costMicroUsd: Number(parseMicroUsd(row?.cost ?? '0')),
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cacheRead: row?.cacheRead ?? 0,
    cacheWrite: row?.cacheWrite ?? 0,
  };
}
