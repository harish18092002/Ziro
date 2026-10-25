import { type ReactNode, useState } from 'react';
import { ApiError, type Availability, type Overview, post } from './api';
import { HeroArt, Logo } from './Brand';
import { linkTo, percent } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Count, Reveal, StatTile } from './ui';

/** Starting a run is the same from the hero, the "try it" section and the closing banner. */
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

export function Home() {
  const { data: offer } = useLoad<Availability>('/demo');
  const replay = offer?.featured.eval ?? null;
  const proof = useLoad<Overview>(replay ? `/runs/${replay}/overview` : null);
  const starter = useRunStarter();

  return (
    <div className="landing page">
      <Hero starter={starter} replay={replay} />
      <ProofStrip proof={proof.data} replay={replay} />
      <Problem />
      <HowItWorks />
      <Features />
      <Safety />
      <Measured />
      <TryIt starter={starter} offer={offer} replay={replay} />
      <Honest />
      <Closing starter={starter} />
      <Footer />
    </div>
  );
}

function StartButton({ starter, size = 'lg' }: { starter: Starter; size?: 'lg' | 'md' }) {
  return (
    <button
      className={`primary ${size === 'lg' ? 'lg' : ''}`}
      onClick={() => void starter.start()}
      disabled={starter.busy}
    >
      {starter.busy ? (
        <>
          <span className="spinner" /> Starting…
        </>
      ) : (
        <>
          <Icon name="bolt" size={18} /> Run the 50-order demo
        </>
      )}
    </button>
  );
}

function ReplayLink({ replay, size = 'lg' }: { replay: string | null; size?: 'lg' | 'md' }) {
  const cls = size === 'lg' ? 'button lg' : 'button';
  return replay ? (
    <a className={cls} href={linkTo(replay)}>
      <Icon name="eye" size={18} /> Replay a 500-order run
    </a>
  ) : (
    <span className={`${cls} disabled`}>500-order replay is being prepared</span>
  );
}

function Hero({ starter, replay }: { starter: Starter; replay: string | null }) {
  return (
    <section className="hero">
      <div className="blob a" />
      <div className="blob b" />
      <div className="blob c" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">
            <Icon name="sparkle" size={15} /> AI finance controller for Razorpay merchants
          </span>
          <h1>
            Every paisa, <span className="grad">accounted for.</span>
          </h1>
          <p className="hero-sub">
            Ziro reconciles your order ledger, Razorpay and your bank statement. Rules settle what
            they can prove, to the paisa. An AI agent investigates the rest. A separate checker
            re-computes every claim, and you approve what matters.
          </p>
          <div className="cta-row">
            <StartButton starter={starter} />
            <ReplayLink replay={replay} />
          </div>
          {starter.problem ? (
            <p className="problem" role="alert">
              <Icon name="alert" size={16} /> {starter.problem}
            </p>
          ) : (
            <p className="micro">No sign-up. Synthetic data only. The demo needs no API key.</p>
          )}
          <ul className="trust">
            <li>
              <Icon name="check" size={15} /> Money in whole paise, never decimals
            </li>
            <li>
              <Icon name="check" size={15} /> Razorpay test mode only
            </li>
            <li>
              <Icon name="check" size={15} /> Every action audited
            </li>
          </ul>
        </div>
        <div className="hero-visual">
          <HeroArt />
        </div>
      </div>
    </section>
  );
}

function ProofStrip({ proof, replay }: { proof: Overview | null; replay: string | null }) {
  const ledger = proof?.coverage.find((c) => c.type === 'ledger_entry');
  const exceptions = proof?.exceptionsByReason.reduce((n, r) => n + r.total, 0) ?? 0;
  return (
    <section className="proof wrap" aria-label="Numbers from the 500-order replay run">
      <div className="proof-head">
        <span className="pill info">
          <Icon name="trend" size={14} /> Live from the 500-order replay
        </span>
        {replay ? <a href={linkTo(replay)}>Open the full run →</a> : null}
      </div>
      <div className="tiles">
        {proof ? (
          <>
            <Reveal i={0}>
              <StatTile
                label="Orders reconciled"
                icon="list"
                hint="synthetic, from a seeded generator"
              >
                <Count value={proof.sources.ledger.records} />
              </StatTile>
            </Reveal>
            <Reveal i={1}>
              <StatTile
                label="Matched by rules alone"
                icon="check"
                tone="good"
                hint="no AI involved, exact to the paisa"
              >
                <Count value={(ledger?.matchRate ?? 0) * 100} format={(n) => percent(n / 100)} />
              </StatTile>
            </Reveal>
            <Reveal i={2}>
              <StatTile
                label="Groups proved by code"
                icon="code"
                hint="orders and payouts, each re-checked"
              >
                <Count value={proof.resolution.ruleGroups} />
              </StatTile>
            </Reveal>
            <Reveal i={3}>
              <StatTile
                label="Exceptions to investigate"
                icon="search"
                tone="open"
                hint="what the rules refused to guess"
              >
                <Count value={exceptions} />
              </StatTile>
            </Reveal>
          </>
        ) : (
          [0, 1, 2, 3].map((n) => <div key={n} className="skel tile-skel" />)
        )}
      </div>
    </section>
  );
}

function SectionHead({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Reveal className="sec-head">
      <span className="kicker" id={id}>
        {eyebrow}
      </span>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </Reveal>
  );
}

const PAINS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'layers',
    title: 'The bank never shows your order amount',
    text: 'Razorpay pays out in batches, about two business days later, minus fees and GST, minus refunds. One deposit can cover seven orders.',
  },
  {
    icon: 'alert',
    title: 'Small things break a one-to-one match',
    text: 'A duplicate payment, an edited ledger amount, a garbled UTR, an order that falls on a different date in UTC and India time.',
  },
  {
    icon: 'trend',
    title: 'Money leaks where nobody looks',
    text: 'Fee overcharges, late or missing settlements and double refunds hide in the month-end pile until the books will not close.',
  },
];

function Problem() {
  return (
    <section className="section" id="problem">
      <div className="wrap">
        <SectionHead
          eyebrow="The problem"
          title="Month-end reconciliation is where books go to die"
        >
          Finance teams line up three documents by hand in Excel. They never agree, and the reasons
          are rarely simple.
        </SectionHead>
        <div className="problem-grid">
          <div className="pains">
            {PAINS.map((p, i) => (
              <Reveal key={p.title} i={i}>
                <div className="pain">
                  <span className="ico">
                    <Icon name={p.icon} size={20} />
                  </span>
                  <div>
                    <h3>{p.title}</h3>
                    <p>{p.text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal i={1}>
            <FeeIllustration />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** One order, and what actually arrives. Rates are illustrative; the figures are fixed, not live. */
function FeeIllustration() {
  return (
    <figure className="card fee-card">
      <figcaption>
        <span className="kicker">One ₹1,000 card order</span>
        <b>What the bank shows is not what you sold</b>
      </figcaption>
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
            <i className="sw fee" /> Razorpay fee, including GST
          </dt>
          <dd>₹23.60</dd>
        </div>
      </dl>
      <p className="note-small">
        Illustrative: a 2% fee (₹20.00) plus 18% GST on the fee (₹3.60). Real rates depend on the
        plan. No ledger row says ₹976.40, and the deposit also holds other orders.
      </p>
    </figure>
  );
}

const STEPS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'upload',
    title: 'Import',
    text: 'Your ledger CSV, Razorpay payments, refunds and settlements, and the bank CSV. Amounts become whole paise and dates become Indian business dates.',
  },
  {
    icon: 'code',
    title: 'Rules match',
    text: 'A strict waterfall: the same order reference and amount, a payout rebuilt from its payments, fees and refunds, then the UTR. Anything ambiguous is left alone.',
  },
  {
    icon: 'bot',
    title: 'Agent investigates',
    text: 'Only the leftovers. The agent reads records through read-only tools and proposes a match or an explanation, citing the evidence it used.',
  },
  {
    icon: 'shield',
    title: 'Checker, then you',
    text: 'Code recomputes every id, amount and date and can refuse the agent. A person approves anything risky, and every step is written to an audit trail.',
  },
];

function HowItWorks() {
  return (
    <section className="section alt" id="how">
      <div className="wrap">
        <SectionHead eyebrow="How it works" title="Four steps, and the AI is only the third">
          Code does the bulk because code can prove it. The agent is for the cases code cannot
          settle, and it never gets the last word.
        </SectionHead>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Reveal i={i}>
                <div className="card step lift">
                  <div className="step-top">
                    <span className="num">{i + 1}</span>
                    <span className="ico">
                      <Icon name={s.icon} size={22} />
                    </span>
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'target',
    title: 'Exact to the paisa',
    text: 'No tolerance on amounts, only on dates. If two records could fit, it is an exception, never a guess.',
  },
  {
    icon: 'search',
    title: 'Explains the leftovers',
    text: 'Fees and GST, batched payouts, netted refunds, chargebacks, duplicates, edited amounts and time-zone shifts, each with a reason code.',
  },
  {
    icon: 'shield',
    title: 'Never trusts the AI',
    text: 'A separate checker recomputes every claim from the records and refuses what it cannot prove.',
  },
  {
    icon: 'user',
    title: 'A person decides',
    text: 'Approve, or reject with a written note. Optional auto-accept is strict, small and switched off in the demo.',
  },
  {
    icon: 'list',
    title: 'A complete audit trail',
    text: 'Every state change is an append-only record. Search any order, payment, payout or UTR and read its whole story.',
  },
  {
    icon: 'rupee',
    title: 'Fee leakage detector',
    text: 'Compares each captured payment with your fee contract and splits any overcharge into base fee and GST.',
  },
  {
    icon: 'clock',
    title: 'Delayed payout watch',
    text: 'Finds payouts that arrived later than the normal lag, and those that are overdue with no bank credit yet.',
  },
  {
    icon: 'book',
    title: 'Books-ready exports',
    text: 'Balanced journal vouchers for Tally, plus CSV and JSON reports that match the screen to the paisa.',
  },
];

function Features() {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <SectionHead
          eyebrow="What you get"
          title="Everything a finance controller checks, in one run"
        />
        <div className="features">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} i={i % 4}>
              <div className="card feature lift">
                <span className="ico">
                  <Icon name={f.icon} size={22} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const GUARDS: {
  icon: IconName;
  who: string;
  role: string;
  may: string;
  maynot: string;
}[] = [
  {
    icon: 'bot',
    who: 'The agent',
    role: 'proposes',
    may: 'Reads this run’s records and suggests a match or an explanation, with evidence.',
    maynot: 'write a match, change data, or follow instructions found in the data.',
  },
  {
    icon: 'shield',
    who: 'The checker',
    role: 'decides',
    may: 'Recomputes the paise, the ids and the date windows, and refuses the agent.',
    maynot: 'be argued with: a proposal that fails the arithmetic is refused.',
  },
  {
    icon: 'user',
    who: 'You',
    role: 'approve',
    may: 'Approve, or reject with a note. Every decision is audited.',
    maynot: 'approve a proposal the checker refused.',
  },
];

function Safety() {
  return (
    <section className="section alt" id="safety">
      <div className="wrap">
        <SectionHead eyebrow="Safety first" title="The AI proposes. Code decides. You approve.">
          A model can be wrong, or be tricked by text hidden in a memo. So it is never allowed to
          write anything.
        </SectionHead>
        <div className="guards">
          {GUARDS.map((g, i) => (
            <Reveal key={g.who} i={i}>
              <div className="card guard lift">
                <div className="guard-top">
                  <span className="ico">
                    <Icon name={g.icon} size={22} />
                  </span>
                  <div>
                    <h3>{g.who}</h3>
                    <span className="role">{g.role}</span>
                  </div>
                </div>
                <p className="may">
                  <Icon name="check" size={16} /> <span>{g.may}</span>
                </p>
                <p className="maynot">
                  <Icon name="x" size={16} />{' '}
                  <span>
                    <b>Cannot</b> {g.maynot}
                  </span>
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <ul className="assurances">
            <li>
              <Icon name="lock" size={18} />
              <span>
                <b>Free text is untrusted.</b> Memos and bank narrations are fenced off and never
                treated as instructions.
              </span>
            </li>
            <li>
              <Icon name="eye" size={18} />
              <span>
                <b>Agent tools are read-only</b> and limited to the current run.
              </span>
            </li>
            <li>
              <Icon name="layers" size={18} />
              <span>
                <b>No model, no problem.</b> If every model runs out of quota, exceptions go to a
                person and the rules keep running.
              </span>
            </li>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

const RESULTS: { value: ReactNode; label: string; text: string; tone: 'good' | 'brand' }[] = [
  {
    value: <Count value={97.4} format={(n) => `${n.toFixed(1)}%`} />,
    label: 'of the answer key reproduced by rules alone',
    text: '520 of 534 true groups on 500 synthetic orders, found exactly.',
    tone: 'good',
  },
  {
    value: <Count value={0} />,
    label: 'false matches',
    text: 'No record was ever linked to the wrong counterpart.',
    tone: 'good',
  },
  {
    value: (
      <>
        <Count value={44} /> of 44
      </>
    ),
    label: 'deliberately wrong proposals refused',
    text: 'The checker rejected every crafted bad proposal, and any one-paisa error defeats it.',
    tone: 'brand',
  },
];

function Measured() {
  return (
    <section className="section" id="proof">
      <div className="wrap">
        <SectionHead eyebrow="Measured, not claimed" title="Every number is reproducible">
          Run <code>npm run eval</code> and the figures come out of the same seed.
        </SectionHead>
        <div className="results">
          {RESULTS.map((r, i) => (
            <Reveal key={r.label} i={i}>
              <div className={`card result tone-${r.tone}`}>
                <div className="result-value">{r.value}</div>
                <b>{r.label}</b>
                <p>{r.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="fine">
          Honest scope: these measure the rules and the checker. How accurate the AI agent is has
          not been measured yet.
        </p>
      </div>
    </section>
  );
}

function TryIt({
  starter,
  offer,
  replay,
}: {
  starter: Starter;
  offer: Availability | null;
  replay: string | null;
}) {
  return (
    <section className="section alt" id="try">
      <div className="wrap">
        <SectionHead eyebrow="Try it" title="Run a batch and watch every difference get explained">
          One click runs 50 synthetic orders through the real pipeline in about two seconds.
        </SectionHead>
        <Reveal>
          <div className="card try-card">
            <div className="try-main">
              <h3>What happens when you click</h3>
              <ol className="try-steps">
                <li>50 orders, their Razorpay records and a bank statement are imported.</li>
                <li>The rules match what they can prove. The rest become exceptions.</li>
                <li>A scripted agent investigates, and the checker verifies each proposal.</li>
                <li>You review the exceptions, approve or reject, and read the audit trail.</li>
              </ol>
              <div className="cta-row">
                <StartButton starter={starter} />
                <ReplayLink replay={replay} />
              </div>
              {starter.problem ? (
                <p className="problem" role="alert">
                  <Icon name="alert" size={16} /> {starter.problem}
                </p>
              ) : null}
            </div>
            <div className="try-options">
              <h3>Options</h3>
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
                    <b>Use a live language model</b>
                    <span>Spends free-tier requests. Off by default.</span>
                  </span>
                </label>
              ) : (
                <p className="muted option-off">
                  <Icon name="lock" size={15} /> Live model:{' '}
                  {offer ? (offer.live.reason ?? 'not available') : 'checking…'}
                </p>
              )}
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
                    <b>Break three investigations on purpose</b>
                    <span>A timeout, an exhausted quota and a cut-off reply, handled.</span>
                  </span>
                </label>
              ) : null}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const HONEST: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'lock',
    title: 'All data is synthetic',
    text: 'Made by a seeded generator shaped like Razorpay’s documented records. Razorpay is used in test mode only.',
  },
  {
    icon: 'code',
    title: 'The free agent is a script',
    text: 'It is a scripted baseline, not a language model. It reads records through the same read-only tools, and everything after it is the real code.',
  },
  {
    icon: 'eye',
    title: 'The replay is read-only',
    text: 'A precomputed 500-order run. Opening it costs nothing and needs no key. “Reset demo” puts your own run away.',
  },
  {
    icon: 'flag',
    title: 'Two mistakes are planted',
    text: 'Each demo run includes two confident, wrong proposals so you can watch the checker refuse them. They are labelled wherever they appear.',
  },
];

function Honest() {
  return (
    <section className="section" id="honest">
      <div className="wrap">
        <SectionHead eyebrow="Straight talk" title="What you are looking at, honestly" />
        <div className="honest">
          {HONEST.map((h, i) => (
            <Reveal key={h.title} i={i}>
              <div className="honest-item">
                <span className="ico">
                  <Icon name={h.icon} size={18} />
                </span>
                <div>
                  <h3>{h.title}</h3>
                  <p>{h.text}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing({ starter }: { starter: Starter }) {
  return (
    <section className="closing">
      <div className="blob a" />
      <div className="blob b" />
      <div className="wrap closing-in">
        <Reveal>
          <h2>See every paisa explained</h2>
          <p>Two seconds, no sign-up, nothing real.</p>
          <div className="cta-row center">
            <StartButton starter={starter} />
          </div>
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
          <Logo size={26} />
          <span>Ziro</span>
        </a>
        <p>Every paisa, accounted for. Synthetic data only, Razorpay test mode.</p>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#safety">Safety</a>
          <a href="#try">Try it</a>
        </nav>
      </div>
    </footer>
  );
}
