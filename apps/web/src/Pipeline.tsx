import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Overview, Progress } from './api';
import { dotPlan, dotProgress, type Route, ROUND_MS, schedule } from './flow';
import { percent } from './format';
import { useLoop, useMedia, usePrefersReducedMotion, useStoryClock } from './hooks';
import { Icon, type IconName } from './Icons';
import { ACTOR, type Actor } from './states';

// The home page hero: the whole backend as one picture. Three sources flow into the rules engine; most records
// take the top lane straight to the books ("proved by code, no AI"), the leftovers take the bottom lane through an
// exception, the AI agent, the checker and a person; a proposal the checker refuses loops back and stays open.
// Dots ride the lanes in the replay run's own proportions, and a narration steps through the seven beats, each
// with a figure read live from that run. It plays only on screen, pauses on demand, and stands still for reduced
// motion. Nothing here claims work is happening now: the figures are labelled as the recorded run's.

type Beat = 'sources' | 'rules' | 'exception' | 'agent' | 'checker' | 'you' | 'books';

interface BeatSpec {
  key: Beat;
  name: string;
  actor: Actor;
  title: string;
  line: string;
}

const BEATS: BeatSpec[] = [
  {
    key: 'sources',
    name: 'Three sources',
    actor: 'code',
    title: 'Three sources, three versions of the truth',
    line: 'Your order ledger, Razorpay’s payments, refunds and settlements, and the bank statement. Money becomes integer paise; dates become IST business days.',
  },
  {
    key: 'rules',
    name: 'Rules T1–T4',
    actor: 'code',
    title: 'Deterministic rules prove the bulk',
    line: 'Four rule tiers match only when amounts agree to the paisa and exactly one candidate fits. Free, instant, provable.',
  },
  {
    key: 'exception',
    name: 'Exception',
    actor: 'code',
    title: 'Anything ambiguous becomes an exception',
    line: 'No guessing: when nothing fits, or two things could, the record is set aside with a reason code and its candidates.',
  },
  {
    key: 'agent',
    name: 'AI agent',
    actor: 'ai',
    title: 'An AI agent investigates, read-only',
    line: 'It reads the case through nine read-only lookups, then proposes a match or an explanation and cites its evidence. It cannot write.',
  },
  {
    key: 'checker',
    name: 'Checker',
    actor: 'code',
    title: 'Code re-checks every claim',
    line: 'The verifier recomputes the paise, the ids and the date windows from the records themselves. It can refuse the AI.',
  },
  {
    key: 'you',
    name: 'You',
    actor: 'you',
    title: 'A person decides',
    line: 'Verified proposals wait for you. Approve and the match is written; reject with a note and the exception reopens.',
  },
  {
    key: 'books',
    name: 'Books & audit',
    actor: 'code',
    title: 'Books close, with a trail',
    line: 'Totals that tie out, fee leakage, late payouts, Tally vouchers, and an append-only audit trail of every step.',
  },
];

const BEAT_MS = 3_800;

// ---------- geometry (one wide layout; a phone gets the narration and a simplified strip) ----------

const SOURCES: { y: number; icon: IconName; title: string }[] = [
  { y: 40, icon: 'book', title: 'Order ledger' },
  { y: 168, icon: 'rupee', title: 'Razorpay' },
  { y: 296, icon: 'bank', title: 'Bank statement' },
];
const SRC_W = 200;
const ENGINE = { x: 330, y: 168, w: 168, h: 104 };
const MID = 220;
const OUT = ENGINE.x + ENGINE.w;
const srcPath = (i: number): string => {
  const c = (SOURCES[i]?.y ?? 0) + 36;
  return `M${SRC_W} ${c} C 268 ${c}, 268 ${MID}, ${ENGINE.x} ${MID}`;
};
const LANE: Record<Route, string> = {
  fast: `M${OUT} ${MID} C 566 ${MID}, 566 70, 640 70 H 1000 C 1062 70, 1100 128, 1100 190`,
  investigate: `M${OUT} ${MID} C 566 ${MID}, 566 360, 640 360 H 1000 C 1062 360, 1100 312, 1100 250`,
  refused: `M${OUT} ${MID} C 566 ${MID}, 566 360, 640 360 H 890 C 872 432, 660 432, 640 360`,
};
const routeFor = (route: Route, source: number): string =>
  `${srcPath(source)} L ${OUT} ${MID} ${LANE[route].replace(/^M\S+ \S+/, '')}`;

const NODES: Record<
  Exclude<Beat, 'sources' | 'rules'>,
  { x: number; y: number; icon: IconName }
> = {
  exception: { x: 640, y: 360, icon: 'search' },
  agent: { x: 765, y: 360, icon: 'bot' },
  checker: { x: 890, y: 360, icon: 'shield' },
  you: { x: 1000, y: 360, icon: 'user' },
  books: { x: 1100, y: 220, icon: 'book' },
};

/** Where along a refused route the checker sits: past it, the dot turns red. */
const CHECKER_AT = 0.73;

export interface PipelineFacts {
  overview: Overview | null;
  progress: Progress | null;
}

/** One live figure per beat, from the recorded 500-order run; null until it arrives. */
function factFor(beat: Beat, { overview: o, progress: p }: PipelineFacts): string | null {
  if (o === null) return null;
  const ledger = o.coverage.find((c) => c.type === 'ledger_entry');
  const exceptions = o.exceptionsByReason.reduce((n, r) => n + r.total, 0);
  switch (beat) {
    case 'sources':
      return `${o.sources.ledger.records} orders · ${o.sources.payments.records} payments · ${o.sources.settlements.records} settlements · ${o.sources.bank.credits.records + o.sources.bank.debits.records} bank lines`;
    case 'rules':
      return ledger
        ? `${ledger.matched} of ${ledger.total} orders proved by code (${percent(ledger.matchRate)}) · ${o.resolution.ruleGroups} groups`
        : null;
    case 'exception':
      return `${exceptions} exceptions, each with a reason code`;
    case 'agent':
      return p
        ? `${p.counts.proposals} proposals${p.agent === 'scripted' ? ' (in this recorded run a scripted stand-in plays the agent)' : ''}`
        : null;
    case 'checker':
      return p
        ? `${p.counts.verified} match claims verified · ${p.counts.refused} refused · ${Math.max(0, p.counts.proposals - p.counts.verified - p.counts.refused)} proposals claimed no match`
        : null;
    case 'you':
      return `${o.resolution.waiting} waiting for a person · nothing is final before`;
    case 'books':
      return `${o.journal.vouchers} vouchers · totals ${o.reconciles ? 'add up to the paisa' : 'do NOT add up'}`;
  }
}

export function Pipeline({ facts }: { facts: PipelineFacts }) {
  const reduced = usePrefersReducedMotion();
  const narrow = useMedia('(max-width: 760px)');
  const [ref, onScreen] = useLoop<HTMLDivElement>();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const running = playing && onScreen && !reduced;
  const t = useStoryClock(running && !narrow, ROUND_MS);
  const routes = useRef<Map<string, SVGPathElement>>(new Map());
  const [, setMeasured] = useState(false);
  useLayoutEffect(() => setMeasured(true), []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setActive((a) => (a + 1) % BEATS.length), BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [running, active]);

  const o = facts.overview;
  const ledger = o?.coverage.find((c) => c.type === 'ledger_entry');
  const share = ledger && ledger.total > 0 ? ledger.matched / ledger.total : 0.9;
  const exceptions = o ? o.exceptionsByReason.reduce((n, r) => n + r.total, 0) : 1;
  const dots = schedule(dotPlan(share, facts.progress?.counts.refused ?? 1, exceptions));
  const beat = BEATS[active] ?? BEATS[0];
  if (beat === undefined) return null;
  const fact = factFor(beat.key, facts);

  const pick = (i: number) => {
    setActive(i);
    setPlaying(false);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (i + step + BEATS.length) % BEATS.length;
    pick(next);
    document.getElementById(`beat-${BEATS[next]?.key}`)?.focus();
  };
  const isOn = (key: Beat) => beat.key === key;

  return (
    <div ref={ref} className="pipe" data-loops={onScreen ? 'on' : 'off'} data-beat={beat.key}>
      {narrow ? null : (
        <svg
          className="pipe-svg"
          viewBox="0 0 1160 448"
          role="img"
          aria-label={`How Ziro works: the order ledger, Razorpay and the bank statement flow into deterministic rules. ${percent(share)} of orders in the recorded run are proved by code and go straight to the books; the rest become exceptions that an AI agent investigates, a checker re-verifies, and a person approves.`}
        >
          <defs>
            <pattern id="pipe-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" className="grid-dot" />
            </pattern>
          </defs>
          <rect
            x="0"
            y="0"
            width="1160"
            height="448"
            fill="url(#pipe-grid)"
            className="pipe-grid"
          />

          {/* the lanes */}
          {SOURCES.map((_, i) => (
            <path key={i} className={`edge ${isOn('sources') ? 'lit' : ''}`} d={srcPath(i)} />
          ))}
          <path
            className={`edge fast ${isOn('rules') || isOn('books') ? 'lit' : ''}`}
            d={LANE.fast}
            style={{ strokeWidth: 1.5 + 8 * share }}
          />
          <path
            className={`edge lane ${['exception', 'agent', 'checker', 'you'].includes(beat.key) ? 'lit' : ''}`}
            d={LANE.investigate}
            style={{ strokeWidth: 1.5 + 8 * (1 - share) }}
          />
          <path
            className={`edge loop ${isOn('checker') ? 'lit' : ''}`}
            d="M890 360 C 872 432, 660 432, 640 360"
          />
          {(['fast', 'investigate', 'refused'] as Route[]).flatMap((r) =>
            SOURCES.map((_, s) => (
              <path
                key={`${r}${s}`}
                ref={(el) => {
                  if (el) routes.current.set(`${r}${s}`, el);
                }}
                d={routeFor(r, s)}
                className="route"
              />
            )),
          )}

          {/* dots under the labels, the engine and the nodes, so they pass behind them */}
          {reduced
            ? null
            : dots.map((d, i) => {
                const p = dotProgress(d, t);
                const path = routes.current.get(`${d.route}${i % 3}`);
                if (p === null || !path) return null;
                const at = path.getPointAtLength(path.getTotalLength() * p);
                const bad = d.route === 'refused' && p > CHECKER_AT;
                return (
                  <circle
                    key={i}
                    className={`pdot ${d.route} ${bad ? 'bad' : ''}`}
                    r="5"
                    transform={`translate(${at.x} ${at.y})`}
                    opacity={Math.min(1, p * 10, (1 - p) * 10)}
                  />
                );
              })}

          <g className="lane-pill" transform="translate(820 70)">
            <rect x="-132" y="-15" width="264" height="30" rx="15" />
            <text y="5" textAnchor="middle">
              Proved by code · no AI · {percent(share)}
            </text>
          </g>
          <text className="loop-label" x="765" y="440" textAnchor="middle">
            refused → stays open
          </text>

          {SOURCES.map((s, i) => (
            <g
              key={s.title}
              className={`src ${isOn('sources') ? 'on' : ''}`}
              transform={`translate(0 ${s.y})`}
              onClick={() => pick(0)}
            >
              <rect width={SRC_W} height="72" rx="10" />
              <rect x="14" y="18" width="36" height="36" rx="8" className="src-ico" />
              <g transform="translate(20 24)">
                <Icon name={s.icon} size={24} />
              </g>
              <text x="64" y="33" className="src-title">
                {s.title}
              </text>
              <text x="64" y="52" className="src-sub">
                {['orders · amounts', 'payments · payouts', 'credits · UTRs'][i]}
              </text>
            </g>
          ))}

          <g
            className={`engine ${isOn('rules') ? 'on' : ''}`}
            transform={`translate(${ENGINE.x} ${ENGINE.y})`}
            onClick={() => pick(1)}
          >
            <rect width={ENGINE.w} height={ENGINE.h} rx="12" />
            <text x="16" y="30" className="engine-title">
              Rules engine
            </text>
            <text x="16" y="48" className="engine-sub">
              exact to the paisa
            </text>
            {['T1', 'T2', 'T3', 'T4'].map((tier, i) => (
              <g key={tier} transform={`translate(${16 + i * 35} 62)`} className="tier">
                <rect width="30" height="24" rx="5" style={{ animationDelay: `${i * 220}ms` }} />
                <text x="15" y="16" textAnchor="middle">
                  {tier}
                </text>
              </g>
            ))}
          </g>

          {(Object.keys(NODES) as (keyof typeof NODES)[]).map((key) => {
            const n = NODES[key];
            const spec = BEATS.find((b) => b.key === key);
            if (!spec) return null;
            return (
              <g
                key={key}
                className={`pnode ${isOn(key) ? 'on' : ''}`}
                transform={`translate(${n.x} ${n.y})`}
                style={{ ['--actor' as string]: ACTOR[spec.actor].color }}
                onClick={() => pick(BEATS.indexOf(spec))}
              >
                <circle className="pnode-halo" r="38" />
                <circle className="pnode-body" r="27" />
                <g transform="translate(-11 -11)">
                  <Icon name={n.icon} size={22} />
                </g>
                <text className="pnode-name" y={key === 'books' ? 52 : 50} textAnchor="middle">
                  {spec.name}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      <div className="pipe-bar">
        <ol className="beats" aria-label="The seven steps">
          {BEATS.map((b, i) => (
            <li key={b.key}>
              <button
                id={`beat-${b.key}`}
                type="button"
                className={`beat ${i === active ? 'on' : ''} ${i < active ? 'past' : ''}`}
                aria-current={i === active ? 'step' : undefined}
                onClick={() => pick(i)}
                onKeyDown={(e) => onKey(e, i)}
                style={{ ['--actor' as string]: ACTOR[b.actor].color }}
              >
                <span className="beat-n">{String(i + 1).padStart(2, '0')}</span>
                <span className="beat-name">{b.name}</span>
                <span className="beat-track" aria-hidden="true">
                  {i === active && running ? (
                    <span key={active} style={{ animationDuration: `${BEAT_MS}ms` }} />
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {reduced ? null : (
          <button
            type="button"
            className="pipe-play ghost sm"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? 'Pause the walkthrough' : 'Play the walkthrough'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </div>

      <div className="pipe-caption" aria-live="polite" key={beat.key}>
        <span className="pipe-actor" style={{ ['--actor' as string]: ACTOR[beat.actor].color }}>
          <Icon name={ACTOR[beat.actor].icon} size={13} /> {ACTOR[beat.actor].label}
        </span>
        <div>
          <h3 className="serif">{beat.title}</h3>
          <p>{beat.line}</p>
          <p className="pipe-fact">
            {fact === null ? (
              <span className="skel fact-skel" />
            ) : (
              <>
                <span className="slash">Recorded 500-order run</span> {fact}
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
