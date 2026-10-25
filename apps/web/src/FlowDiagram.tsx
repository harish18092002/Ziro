import { useEffect, useState } from 'react';
import type { Overview } from './api';
import { usePrefersReducedMotion } from './hooks';
import { Icon, type IconName } from './Icons';
import { cssVars } from './ui';

// The backend, as one batch moves through it. Seven stages on one track; a token travels along it and the
// stage it reaches lights up, with what happens there, the parts of the system involved, and a live number
// from the replay run. It plays by itself, pauses on hover or a click, and stands still for reduced motion.

interface Stage {
  icon: IconName;
  name: string;
  tag: string;
  what: string;
  behind: string[];
  figure: (o: Overview) => string | null;
}

const bankLines = (o: Overview): number =>
  o.sources.bank.credits.records + o.sources.bank.debits.records;
const exceptionCount = (o: Overview): number =>
  o.exceptionsByReason.reduce((n, r) => n + r.total, 0);

const STAGES: Stage[] = [
  {
    icon: 'upload',
    name: 'Import',
    tag: 'files in',
    what: 'Your ledger and bank CSVs and the Razorpay records come in. Every amount becomes whole paise, every date an Indian business date, and every UTR is pulled out of the narration.',
    behind: ['Postgres', 'one transaction per import', 'rows never change'],
    figure: (o) =>
      `${o.sources.ledger.records} ledger entries · ${o.sources.payments.records} payments · ${bankLines(o)} bank lines`,
  },
  {
    icon: 'code',
    name: 'Rules',
    tag: 'no AI',
    what: 'Four strict tiers pair what they can prove: order reference and amount, a payout rebuilt from its payments, the UTR, a unique amount in a date window. Anything doubtful is left alone. Proved groups skip the AI and go straight to the books.',
    behind: ['pure code', 'same result every run', 'zero tolerance on amounts'],
    figure: (o) => `${o.resolution.ruleGroups} groups proved`,
  },
  {
    icon: 'search',
    name: 'Exceptions',
    tag: 'the leftovers',
    what: 'Whatever the rules would not guess about is kept, with the records that could fit and one of 14 reason codes.',
    behind: ['Postgres', '14 reason codes'],
    figure: (o) => `${exceptionCount(o)} exceptions kept open`,
  },
  {
    icon: 'bot',
    name: 'AI agent',
    tag: 'proposes',
    what: 'Each exception is queued. The agent reads records through read-only tools and proposes a match or an explanation, citing its evidence. It cannot write anything.',
    behind: ['Redis queue', 'model router: Gemini first, Claude as fallback', 'read-only tools'],
    figure: (o) => `${o.resolution.waiting} proposals so far`,
  },
  {
    icon: 'shield',
    name: 'Checker',
    tag: 'can refuse',
    what: 'Plain code recomputes every id, amount and date. A proposal that is off by even one paisa is refused, and its exception stays open.',
    behind: ['pure code', 'same arithmetic as the rules'],
    figure: () => '44 of 44 wrong proposals refused',
  },
  {
    icon: 'user',
    name: 'You',
    tag: 'approve',
    what: 'You approve, or reject with a note. Approving checks the records again, then writes the match. Nothing is final without you.',
    behind: ['review queue', 'append-only audit trail'],
    figure: (o) => `${o.resolution.waiting} waiting for review`,
  },
  {
    icon: 'book',
    name: 'Books',
    tag: 'out',
    what: 'Totals that add up to the paisa, fee leakage, late payouts and Tally-ready vouchers, all from the same run.',
    behind: ['CSV and JSON files', 'reproducible numbers'],
    figure: (o) => `${o.journal.vouchers} vouchers for ${o.journal.settlementsBooked} settlements`,
  },
];

const TICK_MS = 4400;

export function FlowDiagram({ proof }: { proof: Overview | null }) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const [hover, setHover] = useState(false);
  const running = playing && !hover && !reduced;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setActive((a) => (a + 1) % STAGES.length), TICK_MS);
    return () => window.clearTimeout(timer);
  }, [running, active]);

  const ledger = proof?.coverage.find((c) => c.type === 'ledger_entry');
  const pct = ledger?.matchRate == null ? null : Math.round(ledger.matchRate * 100);
  const stage = STAGES[active] ?? STAGES[0];
  if (stage === undefined) return null;
  const figure = proof ? stage.figure(proof) : null;

  return (
    <div
      className="flow"
      style={cssVars({ '--i': active, '--n': STAGES.length })}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div className="flow-bar">
        <span className="flow-hint">
          {reduced ? 'Click a step.' : running ? 'Following one batch.' : 'Paused. Click a step.'}
        </span>
        {reduced ? null : (
          <button className="linkbtn" onClick={() => setPlaying((p) => !p)}>
            <Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </div>

      <div className="flow-track">
        <div className="flow-line">
          <span className="fill" />
        </div>
        <span className="flow-token" aria-hidden="true" />
        {STAGES.map((s, i) => (
          <button
            key={s.name}
            className={`flow-node ${i === active ? 'active' : ''} ${i < active ? 'done' : ''}`}
            onClick={() => {
              setActive(i);
              setPlaying(false);
            }}
            aria-pressed={i === active}
            aria-label={`Step ${i + 1}: ${s.name}`}
          >
            <span className="bubble">
              <Icon name={s.icon} size={22} />
            </span>
            <span className="words">
              <span className="label">{s.name}</span>
              <span className="tiny">{s.tag}</span>
            </span>
            <span className="timer" aria-hidden="true">
              {i === active && running ? (
                <span key={active} style={{ animationDuration: `${TICK_MS}ms` }} />
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <div className={`bypass ${active === 1 ? 'on' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 700 46" preserveAspectRatio="none">
          <path d="M150 0 V12 Q150 34 174 34 H626 Q650 34 650 12 V0" />
        </svg>
        <span className="bypass-label">
          {pct === null ? 'Most' : `${pct}%`} of orders stop here: proved by code, no AI needed
        </span>
      </div>

      <div className="flow-detail" key={active} aria-live="polite">
        <div className="flow-what">
          <span className="flow-step">
            Step {active + 1} of {STAGES.length}
          </span>
          <h3>{stage.name}</h3>
          <p>{stage.what}</p>
        </div>
        <div className="flow-side">
          <span className="flow-side-label">Behind the scenes</span>
          <ul className="flow-chips">
            {stage.behind.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {figure ? (
            <>
              <span className="flow-side-label">In the 500-order replay</span>
              <b className="flow-figure">{figure}</b>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
