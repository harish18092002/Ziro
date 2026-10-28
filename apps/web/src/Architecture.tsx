import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ExceptionList, Overview, Progress } from './api';
import { dotPlan, dotProgress, type Route, ROUND_MS, schedule } from './flow';
import { inr, percent, words } from './format';
import { useLoad, useLoop, useMedia, usePrefersReducedMotion, useStoryClock } from './hooks';
import { Icon, type IconName } from './Icons';
import { REASONS, reasonLabel } from './reasons';
import { ACTOR, type Actor } from './states';

// The architecture as one diagram, every stage visible at once, with the detail of whichever stage is picked
// underneath: plain words, a small picture, the technical detail behind a fold, and a real example read from the
// featured 50-order demo run through the existing endpoints. No stage is drawn as doing anything right now.

type StageKey =
  | 'ingest'
  | 'normalize'
  | 'rules'
  | 'matched'
  | 'exceptions'
  | 'agent'
  | 'verifier'
  | 'review'
  | 'report';

interface Stage {
  key: StageKey;
  name: string;
  /** The label under the node in the drawing, when the name is too long. */
  short?: string;
  actor: Actor;
  icon: IconName;
  plain: string;
  deep: string[];
  visual: ReactNode;
}

const TOOLS = [
  'get_exception',
  'get_ledger_entry',
  'search_ledger',
  'get_payment',
  'list_refunds',
  'get_settlement_composition',
  'compute_expected_settlement',
  'search_bank_lines',
  'get_fee_contract',
];

const TIERS: [string, string, string][] = [
  [
    'T1',
    'Ledger ↔ payment',
    'Same cleaned receipt and an equal amount. Refunds attach to their payment.',
  ],
  [
    'T2',
    'Settlement composition',
    'Σ payments − Σ fees (GST-inclusive) − Σ refunds ± adjustments equals the settlement, to the paisa.',
  ],
  [
    'T3',
    'Settlement ↔ bank by UTR',
    'The UTR found in the narration (exact or rejoined) and an equal amount.',
  ],
  [
    'T4',
    'Settlement ↔ bank by amount',
    'Equal amount within the settlement date + 3 business days, and exactly one candidate on each side.',
  ],
];

const STAGES: Stage[] = [
  {
    key: 'ingest',
    name: 'Ingest',
    actor: 'code',
    icon: 'upload',
    plain:
      'Three sources come in: your order ledger, Razorpay (test mode only), and the bank statement.',
    deep: [
      'CSV files are read by a strict RFC 4180 reader that reports each bad row and carries on.',
      'Razorpay is read through the official SDK with test keys only; the app refuses to boot with a live key.',
      'Every import is one transaction with its audit row; a re-import of the same file changes nothing.',
    ],
    visual: (
      <ul className="av-sources">
        <li>
          <Icon name="book" size={16} /> <b>Ledger CSV</b>{' '}
          <code>order_ref · amount · date · memo</code>
        </li>
        <li>
          <Icon name="rupee" size={16} /> <b>Razorpay</b> <code>pay_ · rfnd_ · setl_ · recon</code>
        </li>
        <li>
          <Icon name="bank" size={16} /> <b>Bank CSV</b>{' '}
          <code>value date · narration · credit</code>
        </li>
      </ul>
    ),
  },
  {
    key: 'normalize',
    name: 'Normalize',
    actor: 'code',
    icon: 'refresh',
    plain:
      'Everything is put in one shape: integer paise, Indian business dates, clean references and UTRs.',
    deep: [
      'Money is a bigint of paise everywhere. No floats; rounding is explicit, half-up.',
      'Razorpay timestamps (Unix seconds, UTC) become IST business dates.',
      'The UTR is pulled out of the narration, and repaired when the bank has broken it up.',
    ],
    visual: (
      <table className="av-table">
        <caption>Illustrative values</caption>
        <tbody>
          <tr>
            <td>
              <code>"1,000.00"</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>100000</code> paise
            </td>
          </tr>
          <tr>
            <td>
              <code>1729622700</code> (UTC)
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>23-10-2024</code> IST
            </td>
          </tr>
          <tr>
            <td>
              <code>NEFT/AXISN2429 7123456/RZP</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              UTR <code>AXISN24297123456</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>" ord-1001 "</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>ORD-1001</code>
            </td>
          </tr>
        </tbody>
      </table>
    ),
  },
  {
    key: 'rules',
    name: 'Rules T1–T4',
    actor: 'code',
    icon: 'code',
    plain:
      'A waterfall of four deterministic rules proves the bulk. Strictest first, and never a guess.',
    deep: [
      'Zero tolerance on amounts; tolerance only on dates, in configurable windows.',
      'More than one candidate is ambiguity, and ambiguity is an exception.',
      'Every record ends in exactly one place: a match group, an exception, or ignored.',
    ],
    visual: (
      <ol className="av-tiers">
        {TIERS.map(([tier, name, rule]) => (
          <li key={tier}>
            <span className="av-tier">{tier}</span>
            <div>
              <b>{name}</b>
              <span>{rule}</span>
            </div>
          </li>
        ))}
      </ol>
    ),
  },
  {
    key: 'matched',
    name: 'Accepted groups',
    short: 'Accepted',
    actor: 'code',
    icon: 'check',
    plain:
      'What the rules proved is accepted as a match group straight away: exact to the paisa, with no AI and no review needed.',
    deep: [
      'Two kinds of group: an order with its payments and refunds, and a payout with its bank credit.',
      'A record sits in at most one accepted group; the database enforces it.',
      'Each group records the tier and the rule that made it.',
    ],
    visual: (
      <ul className="av-checks">
        {[
          'Order ↔ payments ↔ refunds, to the paisa',
          'Settlement ↔ bank credit, to the paisa',
          'Tier and rule id kept on every group',
        ].map((c) => (
          <li key={c}>
            <Icon name="check" size={14} /> {c}
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: 'exceptions',
    name: 'Exceptions',
    actor: 'code',
    icon: 'search',
    plain:
      'Whatever the rules could not match safely is set aside, with a reason code and the records that could fit.',
    deep: [
      'Up to 50 candidate records are attached to each exception.',
      'Bank credits no settlement can explain go straight to a person: there is nothing for the AI to find.',
    ],
    visual: (
      <ul className="av-codes">
        {Object.keys(REASONS).map((code) => (
          <li key={code} title={REASONS[code]}>
            {reasonLabel(code)}
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: 'agent',
    name: 'AI agent',
    actor: 'ai',
    icon: 'bot',
    plain:
      'An AI agent investigates one exception at a time with read-only lookups, and proposes. It cannot write a match.',
    deep: [
      'Default harness, single-shot: the code gathers a fixed bundle of lookups, then ONE structured call.',
      'Alternative, loop: the model calls the tools itself, at most four times.',
      'Ledger memos and bank narrations reach it inside <untrusted> tags; instructions in them are ignored.',
      'Every claim must cite a lookup by number, or it is downgraded to "needs a human".',
    ],
    visual: (
      <div className="av-tools">
        <span className="slash">Nine read-only tools, scoped to one run</span>
        <ul>
          {TOOLS.map((t) => (
            <li key={t}>
              <code>{t}</code>
            </li>
          ))}
        </ul>
      </div>
    ),
  },
  {
    key: 'verifier',
    name: 'Checker',
    actor: 'code',
    icon: 'shield',
    plain:
      'Plain code re-computes every proposal from the records. If one paisa is off, it refuses.',
    deep: [
      'The same composition function the rules use; the same date windows.',
      'Records in another run, or already in an accepted match, are refused.',
      'A property test shows any 1-paisa error defeats verification.',
    ],
    visual: (
      <ul className="av-checks">
        {[
          'Σ ledger = Σ payments − refunds, to the paisa',
          'Settlement = payments − fees − refunds ± adjustments',
          'Bank credit = settlement',
          'Dates inside the rule windows',
          'Reason code fits the links',
          'INR only, same run, not already matched',
        ].map((c) => (
          <li key={c}>
            <Icon name="check" size={14} /> {c}
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: 'review',
    name: 'You approve',
    short: 'You approve',
    actor: 'you',
    icon: 'user',
    plain:
      'A verified proposal waits for a person. Approve and the match is written; reject with a note and it reopens.',
    deep: [
      'Approval re-verifies inside one transaction; a stale proposal answers 409, not a wrong match.',
      'Auto-accept only when verified, small, confident (≥ 0.85) and switched on. It is off for demo runs.',
    ],
    visual: (
      <div className="av-decide">
        <span className="av-btn ok">
          <Icon name="check" size={14} /> Approve → match written
        </span>
        <span className="av-btn">
          <Icon name="x" size={14} /> Reject + note → reopened
        </span>
      </div>
    ),
  },
  {
    key: 'report',
    name: 'Reports & audit',
    short: 'Reports & audit',
    actor: 'code',
    icon: 'book',
    plain: 'The run closes into numbers a finance team uses, and every step leaves an audit row.',
    deep: [
      'Every source is partitioned (matched, in an exception, ignored) and must sum to its total.',
      'Fee leakage is judged against the fee contract; undercharges are never netted.',
      'audit_events is append-only: a database trigger refuses UPDATE and DELETE.',
    ],
    visual: (
      <ul className="av-outputs">
        {[
          ['scale', 'Totals that tie out'],
          ['trend', 'Fee leakage'],
          ['clock', 'Late payouts'],
          ['file', 'Tally vouchers'],
          ['list', 'Audit trail'],
        ].map(([icon, label]) => (
          <li key={label}>
            <Icon name={icon as IconName} size={15} /> {label}
          </li>
        ))}
      </ul>
    ),
  },
];

/** Which stage each part of the drawing opens. */
type NodeKey = StageKey;

// ---------- geometry: one wide drawing; phones get the same stages as a vertical list ----------

const SRC = [
  { y: 50, icon: 'book' as const, title: 'Order ledger', sub: 'CSV · orders' },
  { y: 160, icon: 'rupee' as const, title: 'Razorpay', sub: 'test mode · API' },
  { y: 270, icon: 'bank' as const, title: 'Bank statement', sub: 'CSV · credits' },
];
const MID = 190;
const srcPath = (i: number): string => {
  const c = (SRC[i]?.y ?? 0) + 30;
  return `M168 ${c} C 202 ${c}, 202 ${MID}, 226 ${MID}`;
};
const NODE: Record<
  Exclude<NodeKey, 'rules'>,
  { x: number; y: number; icon: IconName; r?: number }
> = {
  ingest: { x: 252, y: MID, icon: 'upload' },
  normalize: { x: 362, y: MID, icon: 'refresh' },
  matched: { x: 760, y: 70, icon: 'check' },
  exceptions: { x: 720, y: 330, icon: 'search' },
  agent: { x: 830, y: 330, icon: 'bot' },
  verifier: { x: 940, y: 330, icon: 'shield' },
  review: { x: 1040, y: 330, icon: 'user' },
  report: { x: 1124, y: MID, icon: 'book', r: 28 },
};
const ENGINE = { x: 430, y: 138, w: 160, h: 104 };
/** The visible edges, each ending at the next node's rim so its arrowhead shows. */
const EDGES: { d: string; lane: 'in' | 'fast' | 'exc' | 'loop'; lit: NodeKey[] }[] = [
  { d: 'M276 190 H 334', lane: 'in', lit: ['ingest', 'normalize'] },
  { d: 'M386 190 H 426', lane: 'in', lit: ['normalize', 'rules'] },
  { d: 'M590 190 C 640 190, 640 70, 690 70 H 732', lane: 'fast', lit: ['rules', 'matched'] },
  { d: 'M786 70 H 1060 C 1100 70, 1124 108, 1124 156', lane: 'fast', lit: ['matched', 'report'] },
  { d: 'M590 190 C 640 190, 640 330, 690 330 H 692', lane: 'exc', lit: ['rules', 'exceptions'] },
  { d: 'M746 330 H 802', lane: 'exc', lit: ['exceptions', 'agent'] },
  { d: 'M856 330 H 912', lane: 'exc', lit: ['agent', 'verifier'] },
  { d: 'M966 330 H 1012', lane: 'exc', lit: ['verifier', 'review'] },
  { d: 'M1066 330 C 1100 330, 1124 292, 1124 224', lane: 'exc', lit: ['review', 'report'] },
  { d: 'M940 384 C 925 436, 735 436, 720 386', lane: 'loop', lit: ['verifier', 'exceptions'] },
];
/** The routes the dots follow, through every node on the way. */
const HEAD = (s: number) => `${srcPath(s)} L 590 ${MID}`;
const ROUTE: Record<Route, string> = {
  fast: ' C 640 190, 640 70, 690 70 H 1060 C 1100 70, 1124 108, 1124 162',
  investigate: ' C 640 190, 640 330, 690 330 H 1040 C 1090 330, 1124 290, 1124 218',
  refused: ' C 640 190, 640 330, 690 330 H 940 L 940 384 C 925 436, 735 436, 720 386 L 720 330',
};
const CHECKER_AT = 0.8;
const TICK_MS = 4_200;

const ORDER: StageKey[] = [
  'ingest',
  'normalize',
  'rules',
  'matched',
  'exceptions',
  'agent',
  'verifier',
  'review',
  'report',
];

/**
 * The whole system at a glance: every stage is drawn at once, the two paths are separate (proved by code, straight
 * to the books; or exception, AI, checker, a person), and dots ride them in the recorded 500-order run's own
 * proportions. A stage is highlighted in turn; click any stage (or pick it from the list on a phone) for what it
 * does, its inputs and tools, the detail behind it and a real example. Still for reduced motion; pausable.
 */
export function Architecture({
  demoRun,
  proof,
  progress,
}: {
  demoRun: string | null;
  proof: Overview | null;
  progress: Progress | null;
}) {
  const reduced = usePrefersReducedMotion();
  const narrow = useMedia('(max-width: 860px)');
  const [ref, onScreen] = useLoop<HTMLDivElement>();
  const [active, setActive] = useState<StageKey>('rules');
  const [playing, setPlaying] = useState(true);
  const running = playing && onScreen && !reduced;
  const t = useStoryClock(running && !narrow, ROUND_MS);
  const routes = useRef<Map<string, SVGPathElement>>(new Map());
  const [, setMeasured] = useState(false);
  useLayoutEffect(() => setMeasured(true), []);
  const examples = useExamples(demoRun);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setActive((a) => ORDER[(ORDER.indexOf(a) + 1) % ORDER.length] ?? 'ingest');
    }, TICK_MS);
    return () => window.clearTimeout(timer);
  }, [running, active]);

  const ledger = proof?.coverage.find((c) => c.type === 'ledger_entry');
  const share = ledger && ledger.total > 0 ? ledger.matched / ledger.total : 0.9;
  const exceptions = proof ? proof.exceptionsByReason.reduce((n, r) => n + r.total, 0) : 1;
  const dots = schedule(dotPlan(share, progress?.counts.refused ?? 1, exceptions));
  const stage = STAGES.find((s) => s.key === active) ?? STAGES[0];
  if (stage === undefined) return null;
  const actor = ACTOR[stage.actor];
  const pick = (k: StageKey) => {
    setActive(k);
    setPlaying(false);
  };
  const lit = (keys: NodeKey[]) => keys.includes(active);
  const nodeProps = (k: StageKey) => ({
    role: 'button',
    tabIndex: 0,
    'aria-pressed': active === k,
    'aria-label': `${STAGES.find((s) => s.key === k)?.name ?? k}: show details`,
    onClick: () => pick(k),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(k);
      }
    },
  });

  return (
    <div ref={ref} className="sysflow" data-loops={onScreen ? 'on' : 'off'}>
      <div className="sf-bar">
        <ul className="sf-legend" aria-label="Legend">
          {(Object.keys(ACTOR) as Actor[]).map((a) => (
            <li key={a}>
              <i style={{ background: ACTOR[a].color }} /> {ACTOR[a].label}
            </li>
          ))}
          <li>
            <i className="lane-key fast" /> Proved path
          </li>
          <li>
            <i className="lane-key exc" /> Exception path
          </li>
          <li>
            <i className="lane-key loop" /> Refused, stays open
          </li>
        </ul>
        {reduced ? null : (
          <button
            type="button"
            className="ghost sm"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? 'Pause the animation' : 'Play the animation'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Pause' : 'Play'}
          </button>
        )}
      </div>

      {narrow ? (
        <ol className="sf-list" aria-label="Stages">
          {ORDER.map((k, i) => {
            const s = STAGES.find((x) => x.key === k);
            if (!s) return null;
            const lane =
              k === 'matched'
                ? 'fast'
                : ['exceptions', 'agent', 'verifier', 'review'].includes(k)
                  ? 'exc'
                  : 'in';
            return (
              <li key={k} className={`lane-${lane}`}>
                <button
                  type="button"
                  className={`sf-item ${active === k ? 'on' : ''}`}
                  style={{ ['--actor' as string]: ACTOR[s.actor].color }}
                  aria-pressed={active === k}
                  onClick={() => pick(k)}
                >
                  <span className="sf-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="sf-ico">
                    <Icon name={s.icon} size={15} />
                  </span>
                  <span className="sf-name">{s.name}</span>
                  <span className="sf-tag">
                    {lane === 'fast'
                      ? 'proved path'
                      : lane === 'exc'
                        ? 'exception path'
                        : ACTOR[s.actor].label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <svg
          className="sf-svg"
          viewBox="0 0 1200 456"
          role="group"
          aria-label={`Ziro's architecture: the order ledger, Razorpay and the bank statement are ingested and normalized, then deterministic rules T1 to T4 run. ${percent(share)} of orders in the recorded run are proved by code and accepted with no AI. The rest become exceptions: an AI agent investigates with read-only tools and proposes, a deterministic checker re-computes the proposal and can refuse it, and a person approves. Everything ends in reports and the audit trail.`}
        >
          <defs>
            <marker
              id="sf-arrow"
              markerUnits="userSpaceOnUse"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="10"
              markerHeight="10"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" className="sf-arrowhead" />
            </marker>
            <pattern id="sf-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" className="grid-dot" />
            </pattern>
          </defs>
          <rect width="1200" height="456" fill="url(#sf-grid)" />

          {SRC.map((_, i) => (
            <path
              key={i}
              className={`sf-edge in ${lit(['ingest']) ? 'lit' : ''}`}
              d={srcPath(i)}
              markerEnd={i === 1 ? 'url(#sf-arrow)' : undefined}
            />
          ))}
          {EDGES.map((e) => (
            <path
              key={e.d}
              className={`sf-edge ${e.lane} ${e.lit.includes(active) ? 'lit' : ''}`}
              d={e.d}
              markerEnd="url(#sf-arrow)"
            />
          ))}
          {(['fast', 'investigate', 'refused'] as Route[]).flatMap((r) =>
            SRC.map((_, s) => (
              <path
                key={`${r}${s}`}
                ref={(el) => {
                  if (el) routes.current.set(`${r}${s}`, el);
                }}
                d={`${HEAD(s)}${ROUTE[r]}`}
                className="sf-route"
              />
            )),
          )}

          {/* dots go under every label and node */}
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
                    r="4.5"
                    transform={`translate(${at.x} ${at.y})`}
                    opacity={Math.min(1, p * 12, (1 - p) * 12)}
                  />
                );
              })}

          <g className="lane-pill" transform="translate(930 70)">
            <rect x="-118" y="-14" width="236" height="28" rx="14" />
            <text y="5" textAnchor="middle">
              Proved by code · no AI · {percent(share)}
            </text>
          </g>
          <text className="sf-note" x="830" y="448" textAnchor="middle">
            refused by the checker → the case stays open
          </text>
          <text className="sf-note" x="880" y="292" textAnchor="middle">
            only the leftovers meet the AI
          </text>

          {SRC.map((s) => (
            <g
              key={s.title}
              className={`src ${active === 'ingest' ? 'on' : ''}`}
              transform={`translate(0 ${s.y})`}
              {...nodeProps('ingest')}
            >
              <rect width="168" height="60" rx="10" />
              <rect x="12" y="14" width="32" height="32" rx="8" className="src-ico" />
              <g transform="translate(17 19)">
                <Icon name={s.icon} size={22} />
              </g>
              <text x="54" y="28" className="src-title">
                {s.title}
              </text>
              <text x="54" y="45" className="src-sub">
                {s.sub}
              </text>
            </g>
          ))}

          <g
            className={`engine ${active === 'rules' ? 'on' : ''}`}
            transform={`translate(${ENGINE.x} ${ENGINE.y})`}
            {...nodeProps('rules')}
          >
            <rect width={ENGINE.w} height={ENGINE.h} rx="12" />
            <text x="14" y="28" className="engine-title">
              Rules T1–T4
            </text>
            <text x="14" y="46" className="engine-sub">
              exact to the paisa
            </text>
            {['T1', 'T2', 'T3', 'T4'].map((tier, i) => (
              <g key={tier} transform={`translate(${14 + i * 34} 60)`} className="tier">
                <rect width="29" height="24" rx="5" style={{ animationDelay: `${i * 220}ms` }} />
                <text x="14.5" y="16" textAnchor="middle">
                  {tier}
                </text>
              </g>
            ))}
          </g>

          {(Object.keys(NODE) as (keyof typeof NODE)[]).map((k) => {
            const n = NODE[k];
            const s = STAGES.find((x) => x.key === k);
            if (!s) return null;
            const r = n.r ?? 24;
            return (
              <g
                key={k}
                className={`pnode ${active === k ? 'on' : ''}`}
                transform={`translate(${n.x} ${n.y})`}
                style={{ ['--actor' as string]: ACTOR[s.actor].color }}
                {...nodeProps(k)}
              >
                <circle className="pnode-halo" r={r + 12} />
                <circle className="pnode-body" r={r} />
                <g transform="translate(-10 -10)">
                  <Icon name={n.icon} size={20} />
                </g>
                {k === 'report' ? (
                  <text className="pnode-name" x={-(r + 10)} y="5" textAnchor="end">
                    {s.short ?? s.name}
                  </text>
                ) : (
                  <text className="pnode-name" y={r + 19} textAnchor="middle">
                    {s.short ?? s.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}

      <section className="sf-panel" aria-live="polite" key={stage.key}>
        <div className="sf-text">
          <header>
            <span className="pipe-actor" style={{ ['--actor' as string]: actor.color }}>
              <Icon name={actor.icon} size={13} /> {actor.label}
            </span>
            <span className="slash">
              Stage {String(ORDER.indexOf(stage.key) + 1).padStart(2, '0')} of{' '}
              {String(ORDER.length).padStart(2, '0')}
            </span>
          </header>
          <h3 className="serif">{stage.name}</h3>
          <p className="arch-plain">{stage.plain}</p>
          <div className="arch-example">
            <span className="slash">In the 50-order demo run</span>
            <p>
              {examples[stage.key] ??
                (demoRun ? 'Loading the demo run…' : 'No demo run on this server yet.')}
            </p>
          </div>
          <details className="arch-deep">
            <summary>
              Under the hood <Icon name="arrow" size={13} />
            </summary>
            <ul>
              {stage.deep.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        </div>
        <div className="arch-visual">{stage.visual}</div>
      </section>
    </div>
  );
}

interface Voucher {
  type: string;
  source: string;
  recordIds: string[];
  debits: { ledger: string; paise: string }[];
}

/** One real example per stage, read from the featured 50-order demo run through the existing endpoints. */
function useExamples(demoRun: string | null): Partial<Record<StageKey, string>> {
  const overview = useLoad<Overview>(demoRun ? `/runs/${demoRun}/overview` : null).data;
  const list = useLoad<ExceptionList>(demoRun ? `/runs/${demoRun}/exceptions` : null).data;
  const report = useLoad<{ vouchers: Voucher[] }>(
    demoRun ? `/runs/${demoRun}/report.json` : null,
  ).data;
  const out: Partial<Record<StageKey, string>> = {};
  if (overview) {
    const s = overview.sources;
    out.ingest = `${s.ledger.records} ledger rows, ${s.payments.records} payments, ${s.refunds.records} refunds, ${s.settlements.records} settlements and ${s.bank.credits.records + s.bank.debits.records} bank lines.`;
    out.normalize = `${inr(s.ledger.amountPaise)} of orders and ${inr(s.payments.feesPaise)} of fees incl. GST, all held as integer paise.`;
    out.matched = `${overview.resolution.ruleGroups} groups accepted by the rules, covering ${overview.matching.matchedRecords} records, with no AI and no review.`;
    out.report = `${overview.journal.vouchers} vouchers for ${overview.journal.settlementsBooked} settlements; the totals ${overview.reconciles ? 'add up to the paisa' : 'do NOT add up'}.`;
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
    out.exceptions = `${key(first)} · ${reasonLabel(first.reasonCode)} · ${inr(first.amountAtStakePaise)} at stake.`;
  const proposed = items.find((e) => e.proposal?.verifier === 'passed');
  if (proposed?.proposal)
    out.agent = `${key(proposed)}: ${words(proposed.proposal.verdict)}${proposed.proposal.author === 'scripted' ? ' (in the demo a script stands in for the model)' : ''}.`;
  const refused = items.find((e) => e.proposal?.verifier === 'rejected');
  if (refused)
    out.verifier = `${key(refused)}: proposal refused${refused.proposal?.author === 'planted' ? ' (a wrong proposal planted on purpose)' : ''}; it stays open.`;
  const waiting = items.find((e) => e.status === 'proposed');
  if (waiting) out.review = `${key(waiting)}: verified, waiting for your approve or reject.`;
  return out;
}
