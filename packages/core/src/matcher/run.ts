import type { RecordType } from '../domain/index.js';
import { matchOrders } from './orders.js';
import { matchPayouts } from './payouts.js';
import { createState, keyOf } from './state.js';
import {
  DEFAULT_MATCHER_CONFIG,
  type MatcherConfig,
  type MatcherInput,
  type MatcherOutput,
  type MatcherStats,
  type RuleGroup,
} from './types.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const firstKey = (group: RuleGroup): string => group.members.map(keyOf).sort()[0] ?? '';

function compareGroups(a: RuleGroup, b: RuleGroup): number {
  return compare(a.tier, b.tier) || compare(firstKey(a), firstKey(b));
}

/**
 * Runs the whole waterfall: T1 (order <-> payment), T2 (settlement composition), T3 (UTR and
 * amount), T4 (amount, window, unique). Pure and deterministic: the result does not depend on the
 * order of the input, because no rule ever breaks a tie. Every input record ends up in exactly one
 * of `groups`, `exceptions` or `ignored`.
 */
export function runMatcher(
  input: MatcherInput,
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): MatcherOutput {
  const state = createState();
  matchOrders(input, config, state);
  matchPayouts(input, config, state);

  const groups = [...state.groups].sort(compareGroups);
  const exceptions = [...state.exceptions.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, exception]) => exception);
  const ignored = [...state.ignored.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([, record]) => record);
  const verdicts = [...state.verdicts];

  const matchedByType: Record<RecordType, number> = {
    ledger_entry: 0,
    rzp_payment: 0,
    rzp_refund: 0,
    rzp_settlement: 0,
    bank_line: 0,
  };
  for (const group of groups) {
    for (const member of group.members) matchedByType[member.recordType] += 1;
  }
  const tally = (type: RecordType, total: number) => ({ total, matched: matchedByType[type] });
  const stats: MatcherStats = {
    groups: {
      T1: groups.filter((g) => g.tier === 'T1').length,
      T3: groups.filter((g) => g.tier === 'T3').length,
      T4: groups.filter((g) => g.tier === 'T4').length,
    },
    settlementsVerified: verdicts.filter((v) => v.verified).length,
    settlementsUnverified: verdicts.filter((v) => !v.verified).length,
    exceptions: exceptions.length,
    ignored: ignored.length,
    matched: {
      ledger_entry: tally('ledger_entry', input.ledger.length),
      rzp_payment: tally('rzp_payment', input.payments.length),
      rzp_refund: tally('rzp_refund', input.refunds.length),
      rzp_settlement: tally('rzp_settlement', input.settlements.length),
      bank_line: tally('bank_line', input.bankLines.length),
    },
  };
  return { groups, verdicts, exceptions, ignored, stats };
}
