// The collector every tier writes to. It enforces the matcher's central invariant AS IT RUNS: a
// record ends in exactly one place (a group, an exception or the ignored list), so a rule that tried
// to claim a record twice would throw instead of silently double-matching.
import type { ReasonCode, RecordRef } from '../domain/index.js';
import { paise } from '../money/index.js';
import {
  type ExceptionCause,
  type IgnoredReason,
  type IgnoredRecord,
  MAX_CANDIDATES,
  type RuleException,
  type RuleGroup,
  type SettlementVerdict,
} from './types.js';

export const keyOf = (r: RecordRef): string => `${r.recordType}:${r.recordId}`;

export interface MatchState {
  readonly groups: RuleGroup[];
  readonly verdicts: SettlementVerdict[];
  readonly exceptions: Map<string, RuleException>;
  readonly ignored: Map<string, IgnoredRecord>;
  /** Keys of every record placed in a group. */
  readonly grouped: Set<string>;
}

export const createState = (): MatchState => ({
  groups: [],
  verdicts: [],
  exceptions: new Map(),
  ignored: new Map(),
  grouped: new Set(),
});

/** Where a record already is, or null if it is still free. */
function placement(state: MatchState, key: string): string | null {
  if (state.grouped.has(key)) return 'a group';
  if (state.exceptions.has(key)) return 'an exception';
  if (state.ignored.has(key)) return 'the ignored list';
  return null;
}

export const isPlaced = (state: MatchState, r: RecordRef): boolean =>
  placement(state, keyOf(r)) !== null;

export function addGroup(state: MatchState, group: RuleGroup): void {
  for (const member of group.members) {
    const where = placement(state, keyOf(member));
    if (where !== null) throw new Error(`${keyOf(member)} is already in ${where}`);
  }
  for (const member of group.members) state.grouped.add(keyOf(member));
  state.groups.push(group);
}

export interface ExceptionInput {
  readonly reasonCode: ReasonCode;
  readonly subject: RecordRef;
  readonly candidates: readonly RecordRef[];
  readonly amountAtStake: bigint;
  readonly cause: ExceptionCause;
  readonly note: string;
}

const byKey = (a: RecordRef, b: RecordRef): number => {
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

export function addException(state: MatchState, input: ExceptionInput): void {
  const key = keyOf(input.subject);
  const where = placement(state, key);
  if (where !== null) throw new Error(`${key} is already in ${where}`);

  const unique = new Map<string, RecordRef>();
  for (const candidate of input.candidates) {
    if (keyOf(candidate) !== key) unique.set(keyOf(candidate), candidate);
  }
  const candidates = [...unique.values()].sort(byKey);
  state.exceptions.set(key, {
    reasonCode: input.reasonCode,
    subject: input.subject,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidateCount: candidates.length,
    amountAtStake: paise(input.amountAtStake),
    cause: input.cause,
    note: input.note,
  });
}

export function addIgnored(state: MatchState, subject: RecordRef, why: IgnoredReason): void {
  const key = keyOf(subject);
  const where = placement(state, key);
  if (where !== null) throw new Error(`${key} is already in ${where}`);
  state.ignored.set(key, { subject, why });
}

/** Adds `value` to the list kept under `key`. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export const byId = <T extends { readonly id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
