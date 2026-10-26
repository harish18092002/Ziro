import evalResult from '../../../packages/evals/results/eval-42/rules-plain.json';
import type { Overview, Progress } from './api';
import { percent } from './format';
import type { MoneyState } from './states';

// Every number the home page shows, with what it counts, out of what, and where it comes from. One module, so a
// figure and its definition cannot drift apart and two parts of the page cannot disagree. Run figures come from
// the 500-order replay run's report (GET /runs/:id/overview and /progress); answer-key figures come from the
// stored result of `npm run eval` (packages/evals/results), the same file the README table is written from.

export interface Metric {
  /** The figure as shown: "95.0%", "523", "0". */
  value: string;
  /** The number behind it, for a count-up. */
  n: number;
  /** How a count-up writes an in-between number. */
  format: (n: number) => string;
  /** The words under the figure. */
  label: string;
  /** The denominator, said out loud: "475 of 500 orders". */
  of?: string;
  /** "How we count": what is counted, out of what, from where. */
  how: string;
}

const whole = (n: number): string => Math.round(n).toLocaleString('en-IN');
const pct = (n: number): string => `${n.toFixed(1)}%`;

const ledgerOf = (o: Overview) => o.coverage.find((c) => c.type === 'ledger_entry');
const exceptionsOf = (o: Overview): number => o.exceptionsByReason.reduce((n, r) => n + r.total, 0);
const approvedByAPerson = (o: Overview): number =>
  o.resolution.agentMatchesApprovedByPerson + o.resolution.agentExplanationsApprovedByPerson;

// ---------- the replay run ----------

export function ordersInRun(o: Overview): Metric {
  const n = o.sources.ledger.records;
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'orders in the replay run',
    how: 'Ledger entries (the merchant’s own orders) imported into the 500-order replay run, a recorded run on generated data.',
  };
}

export function ordersMatched(o: Overview): Metric {
  const ledger = ledgerOf(o);
  const matched = ledger?.matched ?? 0;
  const total = ledger?.total ?? 0;
  const share = total === 0 ? 0 : matched / total;
  const people = approvedByAPerson(o) + o.resolution.autoAccepted;
  return {
    value: percent(share),
    n: share * 100,
    format: pct,
    label: 'of orders matched',
    of: `${whole(matched)} of ${whole(total)} orders`,
    how:
      'Orders that sit in an accepted match group, divided by all orders in the run. ' +
      (people === 0
        ? 'Nothing in this run was approved or auto-accepted, so every one of these matches was made by the rules.'
        : `${people} of the groups came from AI proposals that were approved or auto-accepted.`),
  };
}

export function groupsProved(o: Overview): Metric {
  const n = o.resolution.ruleGroups;
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'groups proved by code',
    how: 'Match groups the rules made: an order with its payments and refunds, or a payout with its bank credit. Every group adds up to the paisa; no AI is involved.',
  };
}

export function exceptionsLeft(o: Overview): Metric {
  const n = exceptionsOf(o);
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'exceptions left for AI and you',
    how: 'Records the rules would not guess about, because nothing fit or more than one thing could. Each one becomes an exception with a reason code.',
  };
}

export function proposalsMade(p: Progress): Metric {
  const n = p.counts.proposals;
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'proposals made',
    how: 'Answers the agent gave, one per exception it took. Exceptions no rule or agent can explain (for example a bank credit with no payout behind it) go straight to a person instead.',
  };
}

export function proposalsRefused(p: Progress): Metric {
  const n = p.counts.refused;
  const planted =
    p.agent === 'scripted'
      ? ' In this run they are the wrong proposals the scripted agent plants on purpose, so the checker has something to refuse.'
      : '';
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'wrong proposals refused by the checker',
    how: `Proposals the checker recomputed and refused: off by a paisa, outside a date window, or linking records it may not.${planted} The checker’s own tests also refuse a set of hand-made wrong proposals, some off by a single paisa.`,
  };
}

export function waitingForYou(o: Overview): Metric {
  const n = o.resolution.waiting;
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'waiting for you',
    how: 'Proposals the checker verified that nobody has approved or rejected yet. Nothing becomes a match until a person approves it.',
  };
}

// ---------- the answer key (npm run eval) ----------

interface EvalRun {
  groups: {
    truthGroups: number;
    exact: number;
    falseMatches: number;
    accepted: { total: number; rule: number };
  };
  exceptions: { total: number; handled: number };
  gap: { strictPaise: string };
  orders: number;
}

export interface EvalFacts {
  seed: number;
  preset: string;
  repeats: number;
  /** True when every repeat gave the same numbers. */
  identical: boolean;
  run: EvalRun;
}

/** The stored rules-only result for the eval preset (seed 42). */
export function evalFacts(
  result: { seed: number; preset: string; runs: EvalRun[] } = evalResult,
): EvalFacts {
  const [first] = result.runs;
  if (first === undefined) throw new Error('the stored eval result has no runs');
  const key = (r: EvalRun) => JSON.stringify([r.groups, r.exceptions, r.gap]);
  return {
    seed: result.seed,
    preset: result.preset,
    repeats: result.runs.length,
    identical: result.runs.every((r) => key(r) === key(first)),
    run: first,
  };
}

export function truthFoundExactly(e: EvalFacts = evalFacts()): Metric {
  const { exact, truthGroups } = e.run.groups;
  const share = truthGroups === 0 ? 0 : exact / truthGroups;
  return {
    value: percent(share),
    n: share * 100,
    format: pct,
    label: 'of the answer key’s groups found exactly',
    of: `${whole(exact)} of ${whole(truthGroups)} groups`,
    how: `The data generator writes an answer key with every true match group. The rules reproduced ${exact} of its ${truthGroups} groups record for record. Measured by npm run eval on ${e.run.orders} orders, seed ${e.seed}${e.repeats > 1 && e.identical ? `, identical over ${e.repeats} runs` : ''}.`,
  };
}

export function falseMatches(e: EvalFacts = evalFacts()): Metric {
  const n = e.run.groups.falseMatches;
  return {
    value: whole(n),
    n,
    format: whole,
    label: 'false matches',
    of: `in ${whole(e.run.groups.accepted.total)} groups accepted`,
    how: `Accepted groups that join records the answer key keeps apart, out of the ${e.run.groups.accepted.total} groups the rules accepted (${e.run.groups.exact} exact, the rest correct but incomplete).`,
  };
}

// ---------- states in a run ----------

/**
 * Which "done" state the run's settled exceptions are in. The report counts them together (approved by a person
 * or auto-accepted), so the colour and words follow whichever actually happened.
 */
export function settledBy(o: Overview): { state: MoneyState; label: string } {
  const people = approvedByAPerson(o);
  const auto = o.resolution.autoAccepted;
  if (auto > 0 && people === 0) return { state: 'ai', label: 'Verified AI explanation' };
  if (auto > 0) return { state: 'you', label: 'Approved or auto-accepted' };
  return { state: 'you', label: 'Approved by you' };
}
