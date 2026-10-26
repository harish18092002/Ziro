import type { IconName } from './Icons';

// The ONE money-state palette, as code: every chart, legend, badge and the flow diagram takes its colour, label
// and icon from here, and the colours themselves are the --st-* tokens in tokens.css. Green means done (three
// greens, one per way of getting there), amber is your turn, orange is open, grey is out of scope.

export type MoneyState = 'rules' | 'ai' | 'you' | 'wait' | 'open' | 'ignored';

export interface StateSpec {
  /** The legend and badge wording, sentence case. */
  label: string;
  /** The fill, a theme token. */
  color: string;
  /** The ink for words written inside the fill (4.5:1 or more in both themes). */
  ink: string;
  /** Shown beside the colour so the colour never carries the meaning alone. */
  icon: IconName;
  /** The class that sets --st for a badge (`pill st st-rules`). */
  className: string;
  /** What the state means, in one sentence: the "how we count" text. */
  means: string;
}

export const STATE: Record<MoneyState, StateSpec> = {
  rules: {
    label: 'Proved by rules',
    color: 'var(--st-rules)',
    ink: 'var(--on-st-rules)',
    icon: 'code',
    className: 'st-rules',
    means: 'Matched by plain code, exact to the paisa. No AI was involved.',
  },
  ai: {
    label: 'Verified AI explanation',
    color: 'var(--st-ai)',
    ink: 'var(--on-st-ai)',
    icon: 'bot',
    className: 'st-ai',
    means:
      'The AI proposed it, the checker recomputed every amount, and it was accepted automatically within the auto-accept limits.',
  },
  you: {
    label: 'Approved by you',
    color: 'var(--st-you)',
    ink: 'var(--on-st-you)',
    icon: 'user',
    className: 'st-you',
    means: 'An AI proposal the checker verified, then approved by a person.',
  },
  wait: {
    label: 'Waiting for you',
    color: 'var(--st-wait)',
    ink: 'var(--on-st-wait)',
    icon: 'clock',
    className: 'st-wait',
    means:
      'The checker verified an AI proposal. Nothing is final until a person approves or rejects it.',
  },
  open: {
    label: 'Open',
    color: 'var(--st-open)',
    ink: 'var(--on-st-open)',
    icon: 'alert',
    className: 'st-open',
    means:
      'No accepted answer yet: the rules could not prove it, and either no proposal was made or the checker refused it.',
  },
  ignored: {
    label: 'Ignored',
    color: 'var(--st-ignored)',
    ink: 'var(--on-st-ignored)',
    icon: 'minus',
    className: 'st-ignored',
    means:
      'Out of scope: records no rule should match (bank lines that are not Razorpay payouts), or exceptions dismissed.',
  },
};

/** The order the states take in a stacked bar and a legend: done first, then your turn, then open. */
export const STATE_ORDER: readonly MoneyState[] = ['rules', 'ai', 'you', 'wait', 'open', 'ignored'];

// Who does a step in the flow. Blue to violet is the brand gradient: code, then AI. You are amber.
export type Actor = 'code' | 'ai' | 'you';

export const ACTOR: Record<Actor, { label: string; color: string; icon: IconName; means: string }> =
  {
    code: {
      label: 'Code',
      color: 'var(--actor-code)',
      icon: 'code',
      means: 'Deterministic code: the same input gives the same answer, every time.',
    },
    ai: {
      label: 'AI',
      color: 'var(--actor-ai)',
      icon: 'bot',
      means: 'A language model. It only proposes; it cannot write a match.',
    },
    you: {
      label: 'You',
      color: 'var(--actor-you)',
      icon: 'user',
      means: 'A person. Approves or rejects; every decision is audited.',
    },
  };
