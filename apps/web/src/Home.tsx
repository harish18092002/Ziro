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
      <Hero starter={starter} replay={replay} />
      <StatsBar proof={proof.data} replay={replay} />
      <WhyHard />
      <HowItWorks proof={proof.data} />
      <Trust />
      <TryIt starter={starter} offer={offer} razorpay={razorpay} />
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

function Hero({ starter, replay }: { starter: Starter; replay: string | null }) {
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
            <StartButton starter={starter} />
            <ReplayLink replay={replay} />
          </div>
          {starter.problem ? (
            <p className="problem" role="alert">
              <Icon name="alert" size={15} /> {starter.problem}
            </p>
          ) : (
            <p className="micro">No sign-up. Synthetic data. No API key needed.</p>
          )}
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

function TryIt({
  starter,
  offer,
  razorpay,
}: {
  starter: Starter;
  offer: Availability | null;
  razorpay: RazorpayStatus | null;
}) {
  const ownAccount = razorpay?.ready === true && razorpay.importsOpen;
  return (
    <section className="section alt" id="try">
      <div className="wrap">
        <Reveal>
          <div className="try">
            <div>
              <h2>Try it on 50 synthetic orders</h2>
              <p className="try-sub">About two seconds. No sign-up.</p>
              <div className="cta-row">
                <StartButton starter={starter} />
                {ownAccount ? (
                  <a className="button lg" href="#/new">
                    Use your Razorpay test account
                  </a>
                ) : null}
              </div>
              {starter.problem ? (
                <p className="problem" role="alert">
                  <Icon name="alert" size={15} /> {starter.problem}
                </p>
              ) : null}
            </div>
            <div className="try-options">
              {offer?.live.available ? (
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
              {offer?.chaos.available ? (
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
            </div>
          </div>
          <p className="honest">
            <Icon name="info" size={15} />
            <span>
              Everything is synthetic, in Razorpay test mode. The free demo’s agent is a script, not
              an AI model, and each run plants two wrong proposals so you can watch the checker
              refuse them.
            </span>
          </p>
        </Reveal>
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
          <a href="#try">Try it</a>
        </nav>
      </div>
    </footer>
  );
}
