// The ONE place a match group is created. Approving an agent proposal and (in the next task) persisting
// what the rule matcher found both come through here, so a group means the same thing however it was
// made: a row in match_groups, one match_link per record, and an audit step naming every record.
//
// The database is the final judge. An accepted group must have a zero residual (CHECK), a rule group
// must name its tier and rule (CHECK), and a record can be in at most one ACCEPTED group (partial unique
// indexes). Racing writers lose on the index, not on a check somebody forgot.
import { randomUUID } from 'node:crypto';
import type { Actor, MATCH_TIERS, ReasonCode, RecordRef } from '@ziro/core/domain';
import { auditSteps } from '../audit/audit.js';
import type { Executor } from '../db/executor.js';
import { matchGroups, matchLinks } from '../db/schema.js';

export interface GroupSpec {
  readonly runId: string;
  readonly kind: 'order' | 'payout';
  readonly status: 'proposed' | 'accepted';
  /** Who made the match: a rule, the agent, or a person. */
  readonly basis: 'rule' | 'agent' | 'human';
  /** Required, with `ruleId`, for a rule-made group. */
  readonly tier?: (typeof MATCH_TIERS)[number] | null;
  readonly ruleId?: string | null;
  /** What explains a known, accounted-for difference, if anything. */
  readonly reasonCode: ReasonCode | null;
  /** Verifier-computed difference in paise; must be 0 for an accepted group. */
  readonly residual: bigint;
  readonly links: readonly RecordRef[];
  /** For the audit trail: who is doing this, and why. */
  readonly actor: Actor;
  readonly reason: string;
}

const COLUMN = {
  ledger_entry: 'ledgerEntryId',
  rzp_payment: 'paymentId',
  rzp_refund: 'refundId',
  rzp_settlement: 'settlementId',
  bank_line: 'bankLineId',
} as const;

const GROUPS_PER_STATEMENT = 300;

/** Writes one group. See `writeGroups`. */
export async function writeGroup(tx: Executor, spec: GroupSpec): Promise<{ groupId: string }> {
  const [groupId] = await writeGroups(tx, [spec]);
  if (groupId === undefined) throw new Error('writing the match group returned no id');
  return { groupId };
}

/** Writes many groups, each with its links and its audit step, a few hundred per statement. */
export async function writeGroups(tx: Executor, specs: readonly GroupSpec[]): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < specs.length; from += GROUPS_PER_STATEMENT) {
    const chunk = specs.slice(from, from + GROUPS_PER_STATEMENT);
    const chunkIds = chunk.map(() => randomUUID());
    await tx.insert(matchGroups).values(
      chunk.map((spec, i) => ({
        id: chunkIds[i] as string,
        runId: spec.runId,
        kind: spec.kind,
        status: spec.status,
        basis: spec.basis,
        tier: spec.tier ?? null,
        ruleId: spec.ruleId ?? null,
        reasonCode: spec.reasonCode,
        residualPaise: spec.residual,
      })),
    );
    await tx.insert(matchLinks).values(
      chunk.flatMap((spec, i) =>
        spec.links.map((link) => ({
          groupId: chunkIds[i] as string,
          groupStatus: spec.status,
          [COLUMN[link.recordType]]: link.recordId,
        })),
      ),
    );
    await auditSteps(
      tx,
      chunk.map((spec, i) => ({
        runId: spec.runId,
        actor: spec.actor,
        action: 'group.create',
        entity: { type: 'match_group', id: chunkIds[i] as string },
        before: null,
        after: {
          kind: spec.kind,
          status: spec.status,
          basis: spec.basis,
          tier: spec.tier ?? null,
          ruleId: spec.ruleId ?? null,
          reasonCode: spec.reasonCode,
          residualPaise: spec.residual,
          links: spec.links.length,
        },
        reason: spec.reason,
        records: spec.links,
      })),
    );
    ids.push(...chunkIds);
  }
  return ids;
}

/** True for a Postgres unique violation, however deeply the driver wrapped it. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
