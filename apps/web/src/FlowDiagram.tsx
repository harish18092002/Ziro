import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ExceptionList, Overview, Progress } from './api';
import { DOTS, dotPlan, dotProgress, type Route, ROUND_MS, schedule } from './flow';
import { inr, percent, sentence, words } from './format';
import { useLoad, useLoop, useMedia, usePrefersReducedMotion, useStoryClock } from './hooks';
import { Icon, type IconName } from './Icons';
import { InfoTip } from './ui';
import { ACTOR, type Actor } from './states';

// The backend as a fork: Import → Rules, then most records go straight to the books ("proved by code, no AI") and
// the leftovers take the investigation lane (Exceptions → AI agent → Checker → You → Books); a proposal the checker
// refuses goes back to Exceptions and stays open. Dots ride the lanes in proportion to the replay run; nodes are
// coloured by who acts. Click a node, or use the arrow keys, for what goes in and out, who acts, a real example from
// the demo run, and how far to trust it. It plays on screen only, and stands still for reduced motion.

type NodeKey = 'import' | 'rules' | 'exceptions' | 'ai' | 'checker' | 'you' | 'books';

interface Stage {
  key: NodeKey;
  name: string;
  actor: Actor;
  icon: IconName;
  takes: string;
  gives: string;
  trust: string;
}

const STAGES: Stage[] = [
  {
    key: 'import',
    name: 'Import',
    actor: 'code',
    icon: 'upload',
    takes: 'Your ledger and bank CSVs, and Razorpay payments, refunds and settlements.',
    gives:
      'Rows in whole paise with Indian business dates and the UTR pulled out of each narration.',
    trust: 'No AI',
  },
  {
    key: 'rules',
    name: 'Rules',
    actor: 'code',
    icon: 'code',
    takes: 'Every imported record.',
    gives: 'Match groups proved to the paisa, and whatever they would not guess about.',
    trust: 'No AI',
  },
  {
    key: 'exceptions',
    name: 'Exceptions',
    actor: 'code',
    icon: 'search',
    takes: 'The records no rule could match safely.',
    gives: 'One exception each, with a reason code and the records that could fit.',
    trust: 'No AI',
  },
  {
    key: 'ai',
    name: 'AI agent',
    actor: 'ai',
    icon: 'bot',
    takes: 'One exception and read-only lookups of the run.',
    gives: 'A proposed match or explanation, citing its evidence. It cannot write.',
    trust: 'AI only proposes',
  },
  {
    key: 'checker',
    name: 'Checker',
    actor: 'code',
    icon: 'shield',
    takes: 'The proposal.',
    gives:
      'Verified, or refused: off by a paisa, outside a date window, or linking what it may not.',
    trust: 'Code re-checks',
  },
  {
    key: 'you',
    name: 'You',
    actor: 'you',
    icon: 'user',
    takes: 'A verified proposal and its evidence.',
    gives: 'Approved (the match is written) or rejected with a note (the exception reopens).',
    trust: 'Human decides',
  },
  {
    key: 'books',
    name: 'Books',
    actor: 'code',
    icon: 'book',
    takes: 'Every accepted group.',
    gives: 'Totals that add up, fee leakage, late payouts and Tally vouchers.',
    trust: 'No AI',
  },
];

type Point = [number, number];
interface Layout {
  box: string;
  nodes: Record<NodeKey, Point>;
  common: string;
  fast: string;
  lane: string;
  loop: string;
  routes: Record<Route, string>;
  fastLabel: Point;
  loopLabel: Point;
}

const WIDE: Layout = {
  box: '0 0 960 370',
  nodes: {
    import: [70, 150],
    rules: [220, 150],
    exceptions: [340, 270],
    ai: [500, 270],
    checker: [660, 270],
    you: [800, 270],
    books: [890, 150],
  },
  common: 'M70 150 H220',
  fast: 'M220 150 C 380 40, 730 40, 890 150',
  lane: 'M220 150 C 250 250, 290 270, 340 270 H800 C 860 270, 890 230, 890 150',
  loop: 'M660 270 C 640 352, 380 352, 340 270',
  routes: {
    fast: 'M70 150 H220 C 380 40, 730 40, 890 150',
    investigate: 'M70 150 H220 C 250 250, 290 270, 340 270 H800 C 860 270, 890 230, 890 150',
    refused: 'M70 150 H220 C 250 250, 290 270, 340 270 H660 C 640 352, 380 352, 340 270',
  },
  fastLabel: [555, 26],
  loopLabel: [500, 358],
};

const TALL: Layout = {
  box: '0 0 360 830',
  nodes: {
    import: [180, 50],
    rules: [180, 150],
    exceptions: [130, 290],
    ai: [130, 410],
    checker: [130, 530],
    you: [130, 650],
    books: [180, 770],
  },
  common: 'M180 50 V150',
  fast: 'M180 150 C 340 250, 340 670, 180 770',
  lane: 'M180 150 C 180 220, 130 230, 130 290 V650 C 130 720, 180 720, 180 770',
  loop: 'M130 530 C 30 500, 30 320, 130 290',
  routes: {
    fast: 'M180 50 V150 C 340 250, 340 670, 180 770',
    investigate: 'M180 50 V150 C 180 220, 130 230, 130 290 V650 C 130 720, 180 720, 180 770',
    refused: 'M180 50 V150 C 180 220, 130 230, 130 290 V530 C 30 500, 30 320, 130 290',
  },
  fastLabel: [340, 470],
  loopLabel: [40, 410],
};

/** Where along the refused route the checker sits: past it, the dot is refused and turns red. */
const CHECKER_AT = 0.64;
const TICK_MS = 4_500;

export function FlowDiagram({
  proof,
  progress,
  demoRun,
}: {
  proof: Overview | null;
  progress: Progress | null;
  demoRun: string | null;
}) {
  const reduced = usePrefersReducedMotion();
  const tall = useMedia('(max-width: 640px)');
  const layout = tall ? TALL : WIDE;
  const [ref, onScreen] = useLoop<HTMLDivElement>();
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const running = playing && onScreen && !reduced;
  const t = useStoryClock(running, ROUND_MS);
  const routes = useRef<Partial<Record<Route, SVGPathElement | null>>>({});
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const examples = useExamples(demoRun);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setActive((a) => (a + 1) % STAGES.length), TICK_MS);
    return () => window.clearTimeout(timer);
  }, [running, active]);

  const ledger = proof?.coverage.find((c) => c.type === 'ledger_entry');
  const share = ledger && ledger.total > 0 ? ledger.matched / ledger.total : 0.9;
  const exceptions = proof ? proof.exceptionsByReason.reduce((n, r) => n + r.total, 0) : 1;
  const plan = dotPlan(share, progress?.counts.refused ?? 1, exceptions);
  const dots = schedule(plan);
  const stage = STAGES[active] ?? STAGES[0];
  if (stage === undefined) return null;
  const actor = ACTOR[stage.actor];

  const pick = (i: number) => {
    setActive(i);
    setPlaying(false);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(i);
    } else if (step !== 0) {
      e.preventDefault();
      const next = (i + step + STAGES.length) % STAGES.length;
      pick(next);
      nodeRefs.current[next]?.focus();
    }
  };

  return (
    <div ref={ref} className="flow2" data-loops={onScreen ? 'on' : 'off'}>
      <div className="flow-bar">
        <div className="flow-legend">
          <ul className="group" aria-label="Who acts">
            <b>Who acts</b>
            {(Object.keys(ACTOR) as Actor[]).map((a) => (
              <li key={a}>
                <i style={{ background: ACTOR[a].color }} /> {ACTOR[a].label}
              </li>
            ))}
          </ul>
          <ul className="group" aria-label="Outcome">
            <b>Outcome</b>
            <li>
              <i className="dot-key ok" /> Proved
            </li>
            <li>
              <i className="dot-key bad" /> Refused
            </li>
          </ul>
        </div>
        {reduced ? null : (
          <button className="linkbtn" onClick={() => setPlaying((p) => !p)}>
            <Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </div>

      <svg
        className={`flow-svg ${tall ? 'tall' : ''}`}
        viewBox={layout.box}
        role="group"
        aria-label={`How records move: ${percent(share)} are proved by code and go straight to the books; the rest go through exceptions, the AI agent, the checker and you.`}
      >
        <path className="edge" d={layout.common} />
        <path className="edge fast" d={layout.fast} style={{ strokeWidth: 2 + 10 * share }} />
        <path className="edge lane" d={layout.lane} style={{ strokeWidth: 2 + 10 * (1 - share) }} />
        <path className="edge loop" d={layout.loop} />
        {(Object.keys(layout.routes) as Route[]).map((r) => (
          <path
            key={r}
            ref={(el) => {
              routes.current[r] = el;
            }}
            d={layout.routes[r]}
            className="route"
          />
        ))}
        <g
          className="lane-pill"
          transform={`translate(${layout.fastLabel[0]} ${layout.fastLabel[1]})${tall ? ' rotate(90)' : ''}`}
        >
          <rect x="-118" y="-15" width="236" height="30" rx="15" />
          <text y="5" textAnchor="middle">
            Proved by code, no AI · {percent(share)}
          </text>
        </g>
        <text
          className="edge-label loop"
          x={layout.loopLabel[0]}
          y={layout.loopLabel[1]}
          textAnchor="middle"
          transform={tall ? `rotate(-90 ${layout.loopLabel[0]} ${layout.loopLabel[1]})` : undefined}
        >
          refused, stays open
        </text>

        {reduced
          ? null
          : dots.map((d, i) => {
              const p = dotProgress(d, t);
              const path = routes.current[d.route];
              if (p === null || !path) return null;
              const at = path.getPointAtLength(path.getTotalLength() * p);
              const bad = d.route === 'refused' && p > CHECKER_AT;
              return (
                <circle
                  key={i}
                  className={`flow-dot ${d.route} ${bad ? 'bad' : ''}`}
                  r="6"
                  transform={`translate(${at.x} ${at.y})`}
                  opacity={Math.min(1, p * 8, (1 - p) * 8)}
                />
              );
            })}

        {STAGES.map((s, i) => {
          const [x, y] = layout.nodes[s.key];
          return (
            <g
              key={s.key}
              ref={(el) => {
                nodeRefs.current[i] = el;
              }}
              className={`fnode ${i === active ? 'on' : ''}`}
              transform={`translate(${x} ${y})`}
              role="button"
              tabIndex={0}
              aria-pressed={i === active}
              aria-label={`${s.name}: ${ACTOR[s.actor].label}. ${s.trust}.`}
              onClick={() => pick(i)}
              onKeyDown={(e) => onKey(e, i)}
              style={{ ['--actor' as string]: ACTOR[s.actor].color }}
            >
              <circle className="fnode-hit" r="34" />
              <circle className="fnode-ring" r="28" />
              <circle className="fnode-body" r="23" />
              <g transform="translate(-11 -11)">
                <Icon name={s.icon} size={22} />
              </g>
              <text className="fnode-name" y="46" textAnchor="middle">
                {s.name}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="flow-note">
        Each dot is a group of records. Green: proved by code. Red: a wrong proposal the checker
        refused.
        <InfoTip
          label="How the dots are counted"
          title="How we count"
          text={`${DOTS} dots a round, in proportion to the 500-order replay run: ${plan.fast} proved by code, ${plan.investigate} investigated, ${plan.refused} refused. Every path that has records gets at least one dot.`}
        />
      </p>

      <div className="card flow-panel" aria-live="polite" key={stage.key}>
        <div className="fp-head">
          <span className="fp-actor" style={{ ['--actor' as string]: actor.color }}>
            <Icon name={actor.icon} size={14} /> {actor.label}
          </span>
          <h3>{stage.name}</h3>
          <span className="fp-trust">{stage.trust}</span>
          {running ? (
            <span className="fp-timer" aria-hidden="true">
              <span key={active} style={{ animationDuration: `${TICK_MS}ms` }} />
            </span>
          ) : null}
        </div>
        <dl className="fp-grid">
          <div>
            <dt>Goes in</dt>
            <dd>{stage.takes}</dd>
          </div>
          <div>
            <dt>Comes out</dt>
            <dd>{stage.gives}</dd>
          </div>
          <div>
            <dt>Who acts</dt>
            <dd>{actor.means}</dd>
          </div>
          <div>
            <dt>In the 50-order demo run</dt>
            <dd className="fp-example">{examples[stage.key] ?? 'Loading the demo run…'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

interface Voucher {
  type: string;
  source: string;
  recordIds: string[];
  debits: { ledger: string; paise: string }[];
}

/** One real example per node, read from the featured 50-order demo run through the existing endpoints. */
function useExamples(demoRun: string | null): Partial<Record<NodeKey, string>> {
  const overview = useLoad<Overview>(demoRun ? `/runs/${demoRun}/overview` : null).data;
  const list = useLoad<ExceptionList>(demoRun ? `/runs/${demoRun}/exceptions` : null).data;
  const report = useLoad<{ vouchers: Voucher[] }>(
    demoRun ? `/runs/${demoRun}/report.json` : null,
  ).data;
  const out: Partial<Record<NodeKey, string>> = {};
  if (overview) {
    const s = overview.sources;
    out.import = `${s.ledger.records} ledger rows, ${s.payments.records} payments, ${s.settlements.records} settlements and ${s.bank.credits.records + s.bank.debits.records} bank lines.`;
    out.books = `${overview.journal.vouchers} vouchers for ${overview.journal.settlementsBooked} settlements; the totals ${overview.reconciles ? 'add up to the paisa' : 'do NOT add up'}.`;
  }
  const receipt = report?.vouchers.find((v) => v.type === 'Receipt' && v.source === 'settlement');
  if (receipt) {
    const setl = receipt.recordIds.find((id) => id.startsWith('setl_')) ?? 'a settlement';
    const pays = receipt.recordIds.filter((id) => id.startsWith('pay_')).length;
    const journal = report?.vouchers.find(
      (v) => v.type === 'Journal' && v.recordIds.includes(setl),
    );
    const leg = (name: string) => journal?.debits.find((d) => d.ledger === name)?.paise ?? '0';
    const net = receipt.debits[0]?.paise ?? '0';
    const fee = leg('Payment Gateway Charges');
    const gst = leg('GST Input Credit');
    const gross = String(BigInt(net) + BigInt(fee) + BigInt(gst));
    out.rules = `${pays} payments of ${inr(gross)} → ${setl}, ${inr(net)} in the bank (fee ${inr(fee)} + GST ${inr(gst)}). Proved to the paisa.`;
  }
  const items = list?.items ?? [];
  const key = (e: (typeof items)[number]) => e.subject?.key ?? e.id.slice(0, 8);
  const first = items.find((e) => !e.listedForAPerson);
  if (first)
    out.exceptions = `${key(first)} · ${sentence(first.reasonCode)} · ${inr(first.amountAtStakePaise)} at stake.`;
  const proposed = items.find((e) => e.proposal?.verifier === 'passed');
  if (proposed?.proposal)
    out.ai = `${key(proposed)}: ${words(proposed.proposal.verdict)}${proposed.proposal.author === 'scripted' ? ' (in the demo a script stands in for the model)' : ''}.`;
  const refused = items.find((e) => e.proposal?.verifier === 'rejected');
  if (refused)
    out.checker = `${key(refused)}: proposal refused${refused.proposal?.author === 'planted' ? ' (a wrong proposal planted on purpose)' : ''}; it stays open.`;
  const waiting = items.find((e) => e.status === 'proposed');
  if (waiting) out.you = `${key(waiting)}: verified, waiting for your approve or reject.`;
  return out;
}
