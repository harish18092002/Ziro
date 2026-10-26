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
import { Logo } from './Brand';
import { FlowDiagram } from './FlowDiagram';
import { linkTo, maskKeyId } from './format';
import { HeroStory } from './HeroStory';
import { useInView, useLoad, useLoop } from './hooks';
import { Icon, type IconName } from './Icons';
import {
  evalFacts,
  exceptionsLeft,
  falseMatches,
  gapAfterRules,
  groupsProved,
  ordersMatched,
  proposalsRefused,
  truthFoundExactly,
} from './metrics';
import { MoneyStory } from './MoneyStory';
import { InfoTip, Reveal, Stat, Term } from './ui';

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

  return (
    <div className="landing page">
      <Hero replay={replay} proof={proof} />
      <WhyHard />
      <HowItWorks proof={proof} progress={progress} demoRun={offer?.featured.demo ?? null} />
      <Trust proof={proof} progress={progress} replay={replay} />
      <StartHere offer={offer} agent={agent} razorpay={razorpay} replay={replay} />
      <Footer />
    </div>
  );
}

function ReplayLink({ replay }: { replay: string | null }) {
  return replay ? (
    <a className="button lg" href={linkTo(replay)}>
      See a 500-order run
    </a>
  ) : (
    <span className="button lg disabled">500-order run loading…</span>
  );
}

function Hero({ replay, proof }: { replay: string | null; proof: Overview | null }) {
  const [ref, running] = useLoop<HTMLElement>();
  const gap = proof ? gapAfterRules(proof) : null;
  return (
    <section ref={ref} className="hero" data-loops={running ? 'on' : 'off'}>
      <div className="aurora" aria-hidden="true">
        <span className="a" />
        <span className="b" />
      </div>
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">Reconciliation for Razorpay merchants</span>
          <h1>
            Every paisa, <span className="grad sweep">accounted for.</span>
          </h1>
          <p className="hero-sub">
            Ziro matches your orders, Razorpay and your bank statement. Rules prove what they can,
            AI explains the rest, and you approve.
          </p>
          <div className="cta-row">
            <a className="button primary lg" href="#start">
              Choose how to start <Icon name="arrow" size={16} />
            </a>
            <ReplayLink replay={replay} />
          </div>
          <p className="micro">Use a Razorpay test account, or built-in demo data. No sign-up.</p>
        </div>
        <figure className="hero-visual">
          <HeroStory gapPaise={gap?.paise ?? null} />
          <figcaption className="hero-caption">
            {gap
              ? `Gap after rules in the 500-order replay (${gap.value}). Goal: ₹0.00 once you review.`
              : 'Goal: ₹0.00 unexplained once you review.'}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <Reveal className="sec-title">
      <h2>{children}</h2>
      {sub ? <p>{sub}</p> : null}
    </Reveal>
  );
}

function WhyHard() {
  return (
    <section className="section" id="why">
      <div className="wrap why">
        <Reveal>
          <h2>The bank never shows what you sold.</h2>
          <p className="why-text">
            Razorpay keeps its <Term k="fee">fee</Term> and the <Term k="gstOnFee">GST on fee</Term>
            , then pays many orders out together, <Term k="t2">T+2</Term>, as one{' '}
            <Term k="settlement">settlement</Term>. The bank line shows one amount and a{' '}
            <Term k="utr">UTR</Term>, not your orders. Matching that by hand is what makes month-end
            slow.
          </p>
        </Reveal>
        <Reveal i={1}>
          <MoneyStory />
        </Reveal>
      </div>
    </section>
  );
}

function HowItWorks({
  proof,
  progress,
  demoRun,
}: {
  proof: Overview | null;
  progress: Progress | null;
  demoRun: string | null;
}) {
  return (
    <section className="section alt" id="how">
      <div className="wrap">
        <Title sub="Most records are proved by code. Only the leftovers meet the AI, and you decide.">
          What happens behind the scenes
        </Title>
        <Reveal>
          <FlowDiagram proof={proof} progress={progress} demoRun={demoRun} />
        </Reveal>
      </div>
    </section>
  );
}

const TRUST: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'target',
    title: 'Exact to the paisa',
    text: 'No tolerance on amounts. If two records could fit, it stays an exception.',
  },
  {
    icon: 'shield',
    title: 'The AI cannot write',
    text: 'It only proposes. A separate checker recomputes every claim and can refuse it.',
  },
  {
    icon: 'user',
    title: 'You approve',
    text: 'Approve, or reject with a note. Every action is in the audit trail.',
  },
  {
    icon: 'book',
    title: 'Books-ready',
    text: 'Fee leakage, late payouts and Tally vouchers come out of the same run.',
  },
];

function Trust({
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
    <section className="section" id="trust">
      <div className="wrap">
        <Title>Built so you can trust the numbers</Title>
        <div className="trust-grid">
          {TRUST.map((t, i) => (
            <Reveal key={t.title} i={i}>
              <div className="card trust-card">
                <span className="ico">
                  <Icon name={t.icon} size={18} />
                </span>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p className="strip-cap">
            In the 500-order replay run {replay ? <a href={linkTo(replay)}>Open it →</a> : null}
          </p>
          <div className="stats-bar" aria-label="Numbers from the 500-order replay run">
            {proof ? (
              run.map((m) => <Stat key={m.label} m={m} />)
            ) : (
              <div className="skel stats-skel" />
            )}
          </div>
          <p className="strip-cap">
            Against the generator’s answer key
            <InfoTip
              label="How we measured"
              title="How we measured"
              text={`npm run eval scores the rules against the answer key the data generator writes: ${facts.run.orders} generated orders, seed ${facts.seed}${facts.repeats > 1 && facts.identical ? `, identical over ${facts.repeats} runs` : ''}.`}
            />
          </p>
          <div className="stats-bar cols-2">
            {[truthFoundExactly(facts), falseMatches(facts)].map((m) => (
              <Stat key={m.label} m={m} />
            ))}
          </div>
          <p className="fine">The AI agent’s own accuracy has not been measured yet.</p>
        </Reveal>
      </div>
    </section>
  );
}

type PathState = 'loading' | 'ready' | 'setup' | 'demo-mode' | 'public';

/** What the test-account card can honestly offer on this server. */
function pathState(razorpay: RazorpayStatus | null): PathState {
  if (razorpay === null) return 'loading';
  if (razorpay.ready && razorpay.importsOpen) return 'ready';
  if (razorpay.ready) return 'demo-mode';
  return razorpay.importsOpen ? 'setup' : 'public';
}

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
}: {
  offer: Availability | null;
  agent: AgentStatus | null;
  razorpay: RazorpayStatus | null;
  replay: string | null;
}) {
  const state = pathState(razorpay);
  const [ref, running] = useLoop<HTMLElement>();
  const starter = useRunStarter();
  const options = agentOptions(offer, agent);
  const [picked, setPicked] = useState<AgentChoice | null>(null);
  const choice = picked ?? options[0]?.id ?? 'scripted';
  const [chaos, setChaos] = useState(false);
  return (
    <section ref={ref} className="section start" id="start" data-loops={running ? 'on' : 'off'}>
      <div className="aurora" aria-hidden="true">
        <span className="a" />
        <span className="b" />
      </div>
      <div className="wrap">
        <Title sub="Watch built-in demo data go through, or reconcile a Razorpay test account.">
          Two ways to start
        </Title>
        <div className="paths">
          <article className="card path path-rec">
            <span className="rec-badge">
              <Icon name="sparkle" size={13} /> Recommended
            </span>
            <span className="path-tag demo">Demo data</span>
            <h3>Built-in demo</h3>
            <p>50 generated orders go through the whole pipeline in about two seconds. No keys.</p>
            <ul className="path-list">
              <li>Rules match what they can prove, to the paisa</li>
              <li>The agent proposes, and a checker can refuse it</li>
              <li>Every step is written to an audit log</li>
            </ul>
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
                    <small>Watch failures get handled.</small>
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
              <ReplayLink replay={replay} />
            </div>
            {starter.problem ? (
              <p className="problem" role="alert">
                <Icon name="alert" size={15} /> {starter.problem}
              </p>
            ) : (
              <p className="path-note">
                Synthetic data. Each run plants two wrong proposals so you can watch the checker
                refuse them.
              </p>
            )}
          </article>

          <article className="card path">
            <span className="path-tag real">Real test data</span>
            <h3>Your Razorpay test account</h3>
            <p>
              Make test payments and refunds in the test account whose keys this server holds, then
              reconcile them against a ledger.
            </p>
            <ul className="path-list">
              <li>Payments and refunds read live from that account</li>
              <li>Bring your own ledger, or start one from its orders</li>
              <li>Nothing made up: an empty account stays empty</li>
            </ul>
            <div className="path-choice path-status">
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
            <p className="path-note">Razorpay test mode only. Nothing here moves real money.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

/** Placeholders until the repository and the video are public: swap the hrefs for the real addresses. */
const LINKS = { github: '#', video: '#', evals: '#' };

function Footer() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <div className="footer-brand">
          <a href="#/" className="brand">
            <Logo size={22} />
            <span>Ziro</span>
          </a>
          <span>Every paisa, accounted for.</span>
        </div>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#trust">Trust</a>
          <a href="#start">Start</a>
          <a href={LINKS.github}>GitHub</a>
          <a href={LINKS.video}>Demo video</a>
          <a href={LINKS.evals}>EVALS.md</a>
        </nav>
        <p className="footer-fine">
          Test mode only · synthetic data · built for the Razorpay AI Builders application
        </p>
      </div>
      <div ref={ref} className={`watermark ${seen ? 'in' : ''}`} aria-hidden="true">
        <span>Ziro</span>
      </div>
    </footer>
  );
}
