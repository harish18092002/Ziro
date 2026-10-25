import { type ReactNode, useState } from 'react';
import { ApiError, type Availability, type Overview, post, type RazorpayStatus } from './api';
import { HeroArt, Logo } from './Brand';
import { FlowDiagram } from './FlowDiagram';
import { linkTo, percent } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Count, Reveal } from './ui';

/** Starting a run is the same from the hero and from the "try it" section. */
function useRunStarter() {
  const [live, setLive] = useState(false);
  const [chaos, setChaos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A run being started shows its progress on its own page; this only starts one.
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { runId } = await post<{ runId: string }>('/demo/runs', {
        agent: live ? 'live' : 'scripted',
        ...(chaos ? { chaos: true } : {}),
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
  return { live, setLive, chaos, setChaos, busy, problem, start };
}
type Starter = ReturnType<typeof useRunStarter>;

export function Home({ razorpay }: { razorpay: RazorpayStatus | null }) {
  const { data: offer } = useLoad<Availability>('/demo');
  const replay = offer?.featured.eval ?? null;
  const proof = useLoad<Overview>(replay ? `/runs/${replay}/overview` : null);
  const starter = useRunStarter();

  return (
    <div className="landing page">
      <Hero replay={replay} />
      <StartHere starter={starter} offer={offer} razorpay={razorpay} replay={replay} />
      <StatsBar proof={proof.data} replay={replay} />
      <WhyHard />
      <HowItWorks proof={proof.data} />
      <Trust />
      <Footer />
    </div>
  );
}

function StartButton({ starter }: { starter: Starter }) {
  return (
    <button className="primary lg" onClick={() => void starter.start()} disabled={starter.busy}>
      {starter.busy ? (
        <>
          <span className="spinner" /> Starting…
        </>
      ) : (
        <>
          <Icon name="bolt" size={17} /> Run the demo
        </>
      )}
    </button>
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

function Hero({ replay }: { replay: string | null }) {
  return (
    <section className="hero">
      <div className="blob a" />
      <div className="blob b" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">Reconciliation for Razorpay merchants</span>
          <h1>
            Every paisa, <span className="grad">accounted for.</span>
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
          <p className="micro">
            Use your own Razorpay test account, or built-in demo data. No sign-up.
          </p>
        </div>
        <div className="hero-visual">
          <HeroArt />
        </div>
      </div>
    </section>
  );
}

/** Four live numbers from the 500-order replay, in one quiet bar rather than four cards. */
function StatsBar({ proof, replay }: { proof: Overview | null; replay: string | null }) {
  const ledger = proof?.coverage.find((c) => c.type === 'ledger_entry');
  const exceptions = proof?.exceptionsByReason.reduce((n, r) => n + r.total, 0) ?? 0;
  const stats: { label: string; value: ReactNode }[] = proof
    ? [
        { label: 'orders reconciled', value: <Count value={proof.sources.ledger.records} /> },
        {
          label: 'matched by rules alone',
          value: <Count value={(ledger?.matchRate ?? 0) * 100} format={(n) => percent(n / 100)} />,
        },
        { label: 'groups proved by code', value: <Count value={proof.resolution.ruleGroups} /> },
        { label: 'left to investigate', value: <Count value={exceptions} /> },
      ]
    : [];
  return (
    <section className="wrap stats-wrap" aria-label="Numbers from the 500-order replay run">
      <div className="stats-bar">
        {proof ? (
          stats.map((s) => (
            <div key={s.label} className="stat">
              <b>{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))
        ) : (
          <div className="skel stats-skel" />
        )}
      </div>
      <p className="stats-note">
        From the 500-order replay run. {replay ? <a href={linkTo(replay)}>Open it →</a> : null}
      </p>
    </section>
  );
}

function Title({ children, sub }: { children: ReactNode; sub?: string }) {
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
            Payouts are batched and arrive net of fees, GST and refunds. A ₹1,000 order lands as
            ₹976.40, mixed in with other orders. Matching that by hand is what makes month-end slow.
          </p>
        </Reveal>
        <Reveal i={1}>
          <FeeIllustration />
        </Reveal>
      </div>
    </section>
  );
}

/** One order, and what actually arrives. Rates are illustrative; the figures are fixed, not live. */
function FeeIllustration() {
  return (
    <figure className="card fee-card">
      <div
        className="fee-bar"
        role="img"
        aria-label="Of ₹1,000.00, ₹976.40 arrives and ₹23.60 is kept as fee and GST"
      >
        <span className="seg pay" />
        <span className="seg fee" />
      </div>
      <dl className="fee-rows">
        <div>
          <dt>
            <i className="sw pay" /> Arrives in your bank
          </dt>
          <dd>₹976.40</dd>
        </div>
        <div>
          <dt>
            <i className="sw fee" /> Fee and GST kept
          </dt>
          <dd>₹23.60</dd>
        </div>
      </dl>
      <figcaption>
        Illustrative: 2% fee plus 18% GST on the fee. Real rates depend on the plan.
      </figcaption>
    </figure>
  );
}

function HowItWorks({ proof }: { proof: Overview | null }) {
  return (
    <section className="section alt" id="how">
      <div className="wrap">
        <Title sub="Follow one batch through the backend, step by step.">
          What happens behind the scenes
        </Title>
        <Reveal>
          <FlowDiagram proof={proof} />
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

const RESULTS: { value: ReactNode; label: string }[] = [
  {
    value: <Count value={97.4} format={(n) => `${n.toFixed(1)}%`} />,
    label: 'of 534 true groups matched by rules',
  },
  { value: <Count value={0} />, label: 'false matches' },
  {
    value: (
      <>
        <Count value={44} /> of 44
      </>
    ),
    label: 'wrong proposals refused by the checker',
  },
];

function Trust() {
  return (
    <section className="section" id="trust">
      <div className="wrap">
        <Title>Built so you can trust the numbers</Title>
        <div className="trust-grid">
          {TRUST.map((t, i) => (
            <Reveal key={t.title} i={i}>
              <div className="trust-item">
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
          <div className="results">
            {RESULTS.map((r) => (
              <div key={r.label} className="result">
                <b>{r.value}</b>
                <span>{r.label}</span>
              </div>
            ))}
          </div>
          <p className="fine">
            Measured on 500 synthetic orders; <code>npm run eval</code> reproduces it. The AI
            agent’s own accuracy has not been measured yet.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

type PathState = 'loading' | 'ready' | 'setup' | 'demo-mode' | 'public';

/** What the "your own account" card can honestly offer on this server. */
function pathState(razorpay: RazorpayStatus | null): PathState {
  if (razorpay === null) return 'loading';
  if (razorpay.ready && razorpay.importsOpen) return 'ready';
  if (razorpay.ready) return 'demo-mode';
  return razorpay.importsOpen ? 'setup' : 'public';
}

const REAL_BUTTON: Record<Exclude<PathState, 'loading' | 'public'>, string> = {
  ready: 'Open my test account',
  setup: 'Set it up (about 2 minutes)',
  'demo-mode': 'One setting to change',
};
const REAL_NOTE: Record<PathState, string> = {
  loading: '',
  ready: 'Connected. Payments and refunds are made in your own test account.',
  setup: 'Needs a pair of test keys from your Razorpay dashboard. The page walks you through it.',
  'demo-mode':
    'Your keys are connected, but DEMO_MODE=true switches this off. The page shows the fix.',
  public: 'Not available on the public demo: run Ziro on your own computer to use your account.',
};

/** The one question the home page asks: whose data do you want to reconcile? */
function StartHere({
  starter,
  offer,
  razorpay,
  replay,
}: {
  starter: Starter;
  offer: Availability | null;
  razorpay: RazorpayStatus | null;
  replay: string | null;
}) {
  const state = pathState(razorpay);
  return (
    <section className="section start" id="start">
      <div className="wrap">
        <Reveal className="sec-title">
          <h2>Two ways to start</h2>
          <p>Reconcile your own Razorpay test account, or watch built-in demo data go through.</p>
        </Reveal>
        <div className="paths">
          <Reveal>
            <article className="card path">
              <span className="path-tag real">Real test data</span>
              <h3>Your Razorpay test account</h3>
              <p>
                Make test payments and refunds in your own Razorpay test account, then reconcile
                them against your ledger.
              </p>
              <ul className="path-list">
                <li>Payments and refunds read live from Razorpay</li>
                <li>Bring your own ledger, or start one from your orders</li>
                <li>Nothing made up: an empty account stays empty</li>
              </ul>
              <div className="path-foot">
                {state === 'loading' ? (
                  <div className="skel path-skel" />
                ) : state === 'public' ? (
                  <span className="button lg disabled">Not on the public demo</span>
                ) : (
                  <a className={`button lg${state === 'ready' ? ' primary' : ''}`} href="#/test">
                    {REAL_BUTTON[state]} <Icon name="arrow" size={16} />
                  </a>
                )}
                <p className="path-note">{REAL_NOTE[state]}</p>
              </div>
            </article>
          </Reveal>

          <Reveal i={1}>
            <article className="card path">
              <span className="path-tag demo">Demo data</span>
              <h3>Built-in demo</h3>
              <p>
                50 generated orders go through the whole pipeline in about two seconds. No setup and
                no keys.
              </p>
              <ul className="path-list">
                <li>Rules match what they can prove, to the paisa</li>
                <li>An agent explains the rest, and a checker can refuse it</li>
                <li>Every step is written to an audit log</li>
              </ul>
              <div className="path-foot">
                <div className="cta-row">
                  <StartButton starter={starter} />
                  <ReplayLink replay={replay} />
                </div>
                {starter.problem ? (
                  <p className="problem" role="alert">
                    <Icon name="alert" size={15} /> {starter.problem}
                  </p>
                ) : (
                  <p className="path-note">
                    Synthetic data. The free demo’s agent is a script, not an AI model, and each run
                    plants two wrong proposals so you can watch the checker refuse them.
                  </p>
                )}
                {offer?.live.available || offer?.chaos.available ? (
                  <details className="fold path-options">
                    <summary>Options</summary>
                    {offer.live.available ? (
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={starter.live}
                          onChange={(e) => {
                            starter.setLive(e.target.checked);
                            if (e.target.checked) starter.setChaos(false);
                          }}
                        />
                        <span className="track" />
                        <span className="words">
                          <b>Use a live AI model</b>
                          <span>Uses free-tier requests.</span>
                        </span>
                      </label>
                    ) : null}
                    {offer.chaos.available ? (
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={starter.chaos}
                          disabled={starter.live}
                          onChange={(e) => starter.setChaos(e.target.checked)}
                        />
                        <span className="track" />
                        <span className="words">
                          <b>Break three investigations</b>
                          <span>Watch failures get handled.</span>
                        </span>
                      </label>
                    ) : null}
                  </details>
                ) : null}
              </div>
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <a href="#/" className="brand">
          <Logo size={22} />
          <span>Ziro</span>
        </a>
        <span>Every paisa, accounted for.</span>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#trust">Trust</a>
          <a href="#start">Start</a>
        </nav>
      </div>
    </footer>
  );
}
