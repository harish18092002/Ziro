// Scoring a run against truth.json. Pure: it is given what the pipeline accepted, as truth keys, and
// says how that compares with the truth. The definitions are the ones in ADR-015:
//
//   match rate   truth groups reproduced exactly / truth groups (partial ones are counted apart)
//   precision    accepted groups with no wrong link / accepted groups
//   FALSE MATCH  an accepted group whose members do not all sit inside ONE truth group. The worst
//                error there is: it books money against the wrong thing. Counted and listed.
//
// A group that is a strict subset of one truth group is not wrong, only incomplete (the rules cannot
// link a duplicate payment's refund, for instance); it is reported as incomplete, not as a false match.
import { ratio } from './stats.js';
import { expectedCodes, type TruthIndex } from './truth.js';

export type GroupKind = 'order' | 'payout';

export interface AcceptedGroup {
  readonly id: string;
  /** Who made it: the rules, or an agent proposal that the verifier passed and a reviewer approved. */
  readonly origin: 'rule' | 'agent';
  readonly kind: GroupKind;
  /** Truth keys (`type:key`) of the records it links. */
  readonly keys: readonly string[];
}

export type KeySetClass =
  | { readonly kind: 'exact'; readonly home: string }
  | { readonly kind: 'partial'; readonly home: string }
  | { readonly kind: 'false'; readonly homes: readonly string[] };

/** Does this set of records belong together, according to the truth? */
export function classifyKeys(index: TruthIndex, keys: readonly string[]): KeySetClass {
  const set = new Set(keys);
  const homes = new Set([...set].map((k) => index.groupOf.get(k) ?? 'none'));
  if (homes.size !== 1 || homes.has('none')) return { kind: 'false', homes: [...homes].sort() };
  const home = [...homes][0] as string;
  const whole = index.members.get(home);
  return { kind: set.size === whole?.size ? 'exact' : 'partial', home };
}

export interface FalseMatch {
  readonly groupId: string;
  readonly origin: 'rule' | 'agent';
  readonly keys: string[];
  /** The truth groups its members belong to; `none` marks a record in no truth group. */
  readonly homes: string[];
}

export const MAX_EXAMPLES = 10;

export interface GroupScore {
  /** Truth groups with at least two records the matcher can link. */
  readonly truthGroups: number;
  readonly exact: number;
  readonly partial: number;
  /** exact / truthGroups. */
  readonly matchRate: number | null;
  /** (exact + partial) / truthGroups. */
  readonly matchRateWithPartial: number | null;
  readonly byKind: Record<GroupKind, { truth: number; exact: number; partial: number }>;
  readonly accepted: { readonly total: number; readonly rule: number; readonly agent: number };
  /** Accepted groups that are a strict subset of one truth group. */
  readonly incomplete: number;
  /** THE FALSE MATCH COUNT. */
  readonly falseMatches: number;
  readonly falseMatchExamples: FalseMatch[];
  /** (accepted - falseMatches) / accepted. */
  readonly precision: number | null;
  /** exact accepted groups / accepted groups. */
  readonly exactShare: number | null;
  /** What the agent added on top of the rules. */
  readonly agentAdded: {
    readonly accepted: number;
    readonly exact: number;
    readonly falseMatches: number;
  };
}

export function scoreGroups(index: TruthIndex, accepted: readonly AcceptedGroup[]): GroupScore {
  const byKind: GroupScore['byKind'] = {
    order: { truth: 0, exact: 0, partial: 0 },
    payout: { truth: 0, exact: 0, partial: 0 },
  };
  for (const g of index.truth.groups) {
    if ((index.members.get(g.id)?.size ?? 0) >= 2) byKind[g.kind].truth += 1;
  }

  const found = new Map<string, 'exact' | 'partial'>();
  const falseMatches: FalseMatch[] = [];
  let incomplete = 0;
  let exactAccepted = 0;
  const agent = { accepted: 0, exact: 0, falseMatches: 0 };
  let rules = 0;

  for (const group of accepted) {
    const c = classifyKeys(index, group.keys);
    if (group.origin === 'agent') agent.accepted += 1;
    else rules += 1;
    if (c.kind === 'false') {
      falseMatches.push({
        groupId: group.id,
        origin: group.origin,
        keys: [...group.keys],
        homes: [...c.homes],
      });
      if (group.origin === 'agent') agent.falseMatches += 1;
      continue;
    }
    if (c.kind === 'exact') {
      exactAccepted += 1;
      if (group.origin === 'agent') agent.exact += 1;
      found.set(c.home, 'exact');
    } else {
      incomplete += 1;
      if (found.get(c.home) !== 'exact') found.set(c.home, 'partial');
    }
  }

  for (const g of index.truth.groups) {
    const how = found.get(g.id);
    if (how !== undefined) byKind[g.kind][how] += 1;
  }
  const truthGroups = byKind.order.truth + byKind.payout.truth;
  const exact = byKind.order.exact + byKind.payout.exact;
  const partial = byKind.order.partial + byKind.payout.partial;

  return {
    truthGroups,
    exact,
    partial,
    matchRate: ratio(exact, truthGroups),
    matchRateWithPartial: ratio(exact + partial, truthGroups),
    byKind,
    accepted: { total: accepted.length, rule: rules, agent: agent.accepted },
    incomplete,
    falseMatches: falseMatches.length,
    falseMatchExamples: falseMatches.slice(0, MAX_EXAMPLES),
    precision: ratio(accepted.length - falseMatches.length, accepted.length),
    exactShare: ratio(exactAccepted, accepted.length),
    agentAdded: agent,
  };
}

// --- reason codes on the exceptions an agent handled -----------------------------------------------------

export interface HandledException {
  readonly exceptionId: string;
  /** Truth key of the exception's subject record. */
  readonly subjectKey: string;
  readonly verdict: string;
  /** The reason code the agent's proposal carries. */
  readonly agentCode: string;
}

export interface ReasonScore {
  readonly handled: number;
  /** Proposals that were not NEEDS_HUMAN. */
  readonly concluded: number;
  readonly abstained: number;
  readonly correct: number;
  /** correct / handled. A NEEDS_HUMAN counts as not correct unless its code happens to be right. */
  readonly accuracy: number | null;
  /** Of the proposals that concluded, how many had a right code. */
  readonly accuracyConcluded: number | null;
  /** By what truth expects (several expected codes are joined with `+`). */
  readonly byExpected: Record<string, { readonly n: number; readonly correct: number }>;
  readonly wrong: {
    readonly exceptionId: string;
    readonly subjectKey: string;
    readonly expected: string[];
    readonly got: string;
  }[];
}

export function scoreReasonCodes(
  index: TruthIndex,
  handled: readonly HandledException[],
): ReasonScore {
  let correct = 0;
  let concluded = 0;
  let correctConcluded = 0;
  const byExpected: Record<string, { n: number; correct: number }> = {};
  const wrong: ReasonScore['wrong'][number][] = [];

  for (const h of handled) {
    const expected = [...expectedCodes(index, h.subjectKey)].sort();
    const ok = expected.includes(h.agentCode);
    const slot = (byExpected[expected.join('+')] ??= { n: 0, correct: 0 });
    slot.n += 1;
    if (h.verdict !== 'NEEDS_HUMAN') concluded += 1;
    if (ok) {
      correct += 1;
      slot.correct += 1;
      if (h.verdict !== 'NEEDS_HUMAN') correctConcluded += 1;
    } else if (wrong.length < MAX_EXAMPLES) {
      wrong.push({
        exceptionId: h.exceptionId,
        subjectKey: h.subjectKey,
        expected,
        got: h.agentCode,
      });
    }
  }
  return {
    handled: handled.length,
    concluded,
    abstained: handled.length - concluded,
    correct,
    accuracy: ratio(correct, handled.length),
    accuracyConcluded: ratio(correctConcluded, concluded),
    byExpected,
    wrong,
  };
}
