import { type ReactNode, useState } from 'react';
import {
  type AgentStatus,
  ApiError,
  type Availability,
  type Overview,
  post,
  type Progress,
  type RazorpayStatus,
} from './api';
import { Architecture } from './Architecture';
import { Logo } from './Brand';
import { linkTo, maskKeyId } from './format';
import { useInView, useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import {
  evalFacts,
  exceptionsLeft,
  falseMatches,
  groupsProved,
  ordersMatched,
  proposalsRefused,
  truthFoundExactly,
} from './metrics';
import { type AccountState, accountState, HeroModes } from './HeroModes';
import { MoneyStory } from './MoneyStory';
import { InfoTip, Reveal, Stat, Term } from './ui';

// The landing page, in the order a judge needs it: what Ziro is and how it works (the hero picture), why the
// problem is hard, the architecture one stage at a time, the measured numbers, then the two ways to start.

/** Which agent a demo run uses. "replay" is a live run on a server that answers from recorded model replies. */
type AgentChoice = 'scripted' | 'live' | 'replay';

function useRunStarter() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A run being started shows its progress on its own page; this only starts one.
  const start = async (agent: AgentChoice, chaos: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      const { runId } = await post<{ runId: string }>('/demo/runs', {
        agent: agent === 'scripted' ? 'scripted' : 'live',
        ...(chaos && agent === 'scripted' ? { chaos: true } : {}),
      });
      window.location.hash = linkTo(runId);
    } catch (e) {
      setBusy(false);
      setProblem(
        e instanceof ApiError && e.status === 429
          ? `Too many runs just now. ${e.message}.`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  };
  return { busy, problem, start };
}

export function Home({ razorpay }: { razorpay: RazorpayStatus | null }) {
  const { data: offer } = useLoad<Availability>('/demo');
  const { data: agent } = useLoad<AgentStatus>('/agent/status');
  const replay = offer?.featured.eval ?? null;
  const proof = useLoad<Overview>(replay ? `/runs/${replay}/overview` : null).data;
  const progress = useLoad<Progress>(replay ? `/runs/${replay}/progress` : null).data;
  const starter = useRunStarter();

  return (
    <div className="landing page">
      <Hero
        replay={replay}
        razorpay={razorpay}
        busy={starter.busy}
        problem={starter.problem}
        onRun={() => void starter.start('scripted', false)}
      />
      <section className="section" id="architecture">
        <div className="wrap">
          <SectionTitle
            n="01"
            label="How it works"
            title={
              <>
                Code proves. AI investigates. <em>You decide.</em>
              </>
            }
            sub="The whole system on one page. Most records take the top path and never meet the AI; only the leftovers go through investigation, the checker and you. Pick any stage for its detail."
          />
          <Reveal>
            <Architecture
              demoRun={offer?.featured.demo ?? null}
              proof={proof}
              progress={progress}
            />
          </Reveal>
        </div>
      </section>
      <Problem />
      <Proof proof={proof} progress={progress} replay={replay} />
      <StartHere
        offer={offer}
        agent={agent}
        razorpay={razorpay}
        replay={replay}
        starter={starter}
      />
      <Footer replay={replay} />
    </div>
  );
}

function SectionTitle({
  n,
  label,
  title,
  sub,
}: {
  n: string;
  label: string;
  title: ReactNode;
  sub?: string;
}) {
  return (
    <Reveal className="sec-title">
      <span className="slash">
        {n} {label}
      </span>
      <h2 className="serif">{title}</h2>
      {sub ? <p>{sub}</p> : null}
    </Reveal>
  );
}

function Hero({
  replay,
  razorpay,
  busy,
  problem,
  onRun,
}: {
  replay: string | null;
  razorpay: RazorpayStatus | null;
  busy: boolean;
  problem: string | null;
  onRun: () => void;
}) {
  const account = accountState(razorpay);
  return (
    <section className="hero">
      <div className="hero-glow" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="slash">AI finance controller for Razorpay merchants</span>
          <h1 className="serif">
            Every paisa, <em>accounted for.</em>
          </h1>
          <p className="hero-sub">
            Ziro reconciles your order ledger, Razorpay and your bank statement. Code proves the
            bulk to the paisa, an AI agent investigates what is left, a checker re-computes its
            every claim, and you approve.
          </p>
          <p className="hero-rzp">
            <Icon name="shield" size={15} />
            <span>
              Works with a real <b>Razorpay test account</b>: make test payments and refunds, import
              them, and reconcile.
            </span>
          </p>
          <div className="cta-row">
            <button className="primary lg" onClick={onRun} disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" /> Starting…
                </>
              ) : (
                <>
                  Run sample demo <Icon name="arrow" size={16} />
                </>
              )}
            </button>
            <a className="button lg" href={account === 'public' ? '#start' : '#/test'}>
              Try with Razorpay test payments
            </a>
          </div>
          {problem ? (
            <p className="problem" role="alert">
              <Icon name="alert" size={15} /> {problem}
            </p>
          ) : (
            <p className="micro">
              Sample demo: 50 synthetic orders, about two seconds.{' '}
              <a href="#architecture">How it works ↓</a>
              {replay ? (
                <>
                  {' · '}
                  <a href={linkTo(replay)}>Recorded 500-order run →</a>
                </>
              ) : null}
            </p>
          )}
        </div>
        <HeroModes razorpay={razorpay} onRunDemo={onRun} busy={busy} />
      </div>
    </section>
  );
}

const PAINS: { icon: IconName; title: string; text: ReactNode }[] = [
  {
    icon: 'rupee',
    title: 'Fees come off first',
    text: (
      <>
        Razorpay keeps its <Term k="fee">fee</Term> and the <Term k="gstOnFee">GST on fee</Term>{' '}
        before paying out.
      </>
    ),
  },
  {
    icon: 'layers',
    title: 'Payouts are batched',
    text: (
      <>
        Many orders arrive <Term k="t2">T+2</Term> as one <Term k="settlement">settlement</Term>.
      </>
    ),
  },
  {
    icon: 'bank',
    title: 'The bank shows a UTR',
    text: (
      <>
        One amount and a <Term k="utr">UTR</Term>, often garbled. Never your order numbers.
      </>
    ),
  },
];

function Problem() {
  return (
    <section className="section" id="problem">
      <div className="wrap problem-grid">
        <div>
          <SectionTitle
            n="02"
            label="The problem"
            title={
              <>
                The bank never shows <em>what you sold.</em>
              </>
            }
            sub="So finance teams match it by hand in Excel at month-end, and fee overcharges, missing payouts and double refunds slip through."
          />
          <ul className="pains">
            {PAINS.map((p, i) => (
              <Reveal key={p.title} i={i}>
                <li>
                  <span className="pain-ico">
                    <Icon name={p.icon} size={16} />
                  </span>
                  <div>
                    <b>{p.title}</b>
                    <span>{p.text}</span>
                  </div>
                </li>
              </Reveal>
            ))}
          </ul>
        </div>
        <Reveal i={1}>
          <MoneyStory />
        </Reveal>
      </div>
    </section>
  );
}

function Proof({
  proof,
  progress,
  replay,
}: {
  proof: Overview | null;
  progress: Progress | null;
  replay: string | null;
}) {
  const facts = evalFacts();
  const run = proof
    ? [
        ordersMatched(proof),
        groupsProved(proof),
        exceptionsLeft(proof),
        ...(progress ? [proposalsRefused(progress)] : []),
      ]
    : [];
  return (
    <section className="section" id="proof">
      <div className="wrap">
        <SectionTitle
          n="03"
          label="Proof"
          title={
            <>
              Numbers you can <em>reproduce.</em>
            </>
          }
          sub="Every figure says what it counts and out of what. Press ⓘ for how."
        />
        <Reveal>
          <div className="proof-head">
            <span className="slash">Recorded 500-order run</span>
            {replay ? <a href={linkTo(replay)}>Open it →</a> : null}
          </div>
          <div className="proof-row">
            {proof ? (
              run.map((m) => <Stat key={m.label} m={m} />)
            ) : (
              <div className="skel proof-skel" />
            )}
          </div>
          <div className="proof-head">
            <span className="slash">Against the generator’s answer key</span>
            <InfoTip
              label="How we measured"
              title="How we measured"
              text={`npm run eval scores the rules against the answer key the data generator writes: ${facts.run.orders} generated orders, seed ${facts.seed}${facts.repeats > 1 && facts.identical ? `, identical over ${facts.repeats} runs` : ''}.`}
            />
          </div>
          <div className="proof-row two">
            {[truthFoundExactly(facts), falseMatches(facts)].map((m) => (
              <Stat key={m.label} m={m} />
            ))}
          </div>
          <p className="fine">
            <Icon name="info" size={13} /> The AI agent’s own accuracy has not been measured yet;
            these figures are the rules and the checker.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

type PathState = AccountState;
const pathState = accountState;

const REAL_BUTTON: Record<Exclude<PathState, 'loading' | 'public'>, string> = {
  ready: 'Open the test account',
  setup: 'Set it up (about 2 minutes)',
  'demo-mode': 'One setting to change',
};

/** Says exactly whose account this is: the one whose keys sit in this server's .env. */
function realNote(state: PathState, keyId: string | null): string {
  const key = keyId ? maskKeyId(keyId) : 'its key';
  switch (state) {
    case 'ready':
      return `Connected to ${key}. Payments and refunds you make here go to that account.`;
    case 'setup':
      return 'No test keys on this server yet. The page shows where to copy them from your Razorpay dashboard.';
    case 'demo-mode':
      return `Keys for ${key} are set, but this server runs as a public demo, so imports are off. The page shows the fix.`;
    case 'public':
      return 'Not on the public demo: run Ziro on your own computer with your own test keys.';
    default:
      return '';
  }
}

function agentOptions(offer: Availability | null, agent: AgentStatus | null) {
  const replaying = agent?.cache === 'replay';
  const live = offer?.live.available === true;
  const options: { id: AgentChoice; label: string; note: string }[] = [];
  if (live && replaying)
    options.push({
      id: 'replay',
      label: 'Recorded AI run, replayed',
      note: 'Real model answers recorded earlier, replayed. No live calls.',
    });
  options.push({
    id: 'scripted',
    label: 'Scripted',
    note: 'A script stands in for the agent. No AI model is used.',
  });
  if (live && !replaying)
    options.push({
      id: 'live',
      label: 'Live AI model',
      note: 'Asks the configured model now, on free-tier requests.',
    });
  return options;
}

function StartHere({
  offer,
  agent,
  razorpay,
  replay,
  starter,
}: {
  offer: Availability | null;
  agent: AgentStatus | null;
  razorpay: RazorpayStatus | null;
  replay: string | null;
  starter: ReturnType<typeof useRunStarter>;
}) {
  const state = pathState(razorpay);
  const options = agentOptions(offer, agent);
  const [picked, setPicked] = useState<AgentChoice | null>(null);
  const choice = picked ?? options[0]?.id ?? 'scripted';
  const [chaos, setChaos] = useState(false);
  return (
    <section className="section start" id="start">
      <div className="wrap">
        <SectionTitle
          n="04"
          label="Try it"
          title={
            <>
              Two ways in. <em>Same pipeline.</em>
            </>
          }
          sub="Generated demo data in two seconds, or your own Razorpay test account. The labels never mix the two."
        />
        <div className="paths">
          <article className="card path path-rec">
            <div className="path-top">
              <span className="path-tag demo">
                <Icon name="sparkle" size={13} /> Instant demo · synthetic data
              </span>
              <span className="rec-badge">Recommended</span>
            </div>
            <h3 className="serif">Built-in demo</h3>
            <p>50 generated orders through the whole pipeline in about two seconds. No keys.</p>
            <fieldset className="path-choice">
              <legend>Who plays the agent</legend>
              {options.map((o) => (
                <label key={o.id} className={`choice-row ${choice === o.id ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="agent"
                    value={o.id}
                    checked={choice === o.id}
                    onChange={() => setPicked(o.id)}
                  />
                  <span>
                    <b>{o.label}</b>
                    <small>{o.note}</small>
                  </span>
                </label>
              ))}
              {offer?.chaos.available && choice === 'scripted' ? (
                <label className="choice-row">
                  <input
                    type="checkbox"
                    checked={chaos}
                    onChange={(e) => setChaos(e.target.checked)}
                  />
                  <span>
                    <b>Break three investigations</b>
                    <small>A timeout, no quota, a cut-off reply. Watch them get handled.</small>
                  </span>
                </label>
              ) : null}
            </fieldset>
            <div className="path-cta">
              <button
                className="primary lg"
                onClick={() => void starter.start(choice, chaos)}
                disabled={starter.busy}
              >
                {starter.busy ? (
                  <>
                    <span className="spinner" /> Starting…
                  </>
                ) : (
                  <>
                    Run the demo <Icon name="arrow" size={16} />
                  </>
                )}
              </button>
              {replay ? (
                <a className="button lg ghost" href={linkTo(replay)}>
                  500-order replay
                </a>
              ) : null}
            </div>
            {starter.problem ? (
              <p className="problem" role="alert">
                <Icon name="alert" size={15} /> {starter.problem}
              </p>
            ) : (
              <p className="path-note">
                Each run plants two wrong proposals, so you can watch the checker refuse them.
              </p>
            )}
          </article>

          <article className="card path">
            <div className="path-top">
              <span className="path-tag real">
                <Icon name="shield" size={13} /> Razorpay test mode · your data
              </span>
            </div>
            <h3 className="serif">Your test account</h3>
            <p>
              Make test payments and refunds in the account whose keys this server holds, then
              reconcile them against a ledger.
            </p>
            <ul className="path-list">
              <li>Payments and refunds read live from that account</li>
              <li>Bring your own ledger, or start one from its orders</li>
              <li>Nothing made up: an empty account stays empty</li>
            </ul>
            <div className="path-status">
              <span className={`status-dot ${state === 'ready' ? 'ok' : ''}`} />
              <p>
                {realNote(state, razorpay?.keyId ?? null)}
                <InfoTip
                  label="Whose account is this?"
                  title="Whose account"
                  text="The Razorpay test account whose key id and secret are in this server's .env file (RAZORPAY_KEY_ID). On your own computer, that is yours. Test mode only: nothing moves real money."
                />
              </p>
            </div>
            <div className="path-cta">
              {state === 'loading' ? (
                <div className="skel path-skel" />
              ) : state === 'public' ? (
                <span className="button lg disabled">Not on the public demo</span>
              ) : (
                <a className={`button lg${state === 'ready' ? ' primary' : ''}`} href="#/test">
                  {REAL_BUTTON[state]} <Icon name="arrow" size={16} />
                </a>
              )}
            </div>
            <p className="path-note">Test mode only. Nothing here moves real money.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

/**
 * The footer, layered: the wordmark is drawn huge and faint BEHIND the footer's content and cropped by its bottom
 * edge, so it reads as texture, not as a figure. Product links only.
 */
function Footer({ replay }: { replay: string | null }) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <footer ref={ref} className={`footer ${seen ? 'in' : ''}`}>
      <div className="watermark" aria-hidden="true">
        Ziro
      </div>
      <div className="wrap footer-in">
        <div className="footer-brand">
          <a href="#/" className="brand">
            <Logo size={22} />
            <span>Ziro</span>
          </a>
          <p>
            Reconciliation for Razorpay merchants. Rules prove the bulk, an AI agent investigates
            the rest, a checker re-computes, and you approve.
          </p>
        </div>
        <nav className="footer-cols" aria-label="Footer">
          <div>
            <span className="footer-head">Product</span>
            <a href="#architecture">How it works</a>
            <a href="#problem">The problem</a>
            <a href="#proof">Proof</a>
          </div>
          <div>
            <span className="footer-head">Try it</span>
            <a href="#start">Sample demo</a>
            <a href="#/test">Test account</a>
            {replay ? <a href={linkTo(replay)}>500-order replay</a> : null}
          </div>
        </nav>
      </div>
      <div className="wrap footer-base">
        <span>© 2026 Ziro</span>
        <span>
          Razorpay test mode only <i aria-hidden="true">◆</i> no real money moves
        </span>
      </div>
    </footer>
  );
}
