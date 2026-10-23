import { useEffect, useState } from 'react';
import { type AgentStatus, ApiError, type Availability, get, post } from './api';
import { agentBanner, linkTo, parseHash } from './format';
import { useHash, useLoad } from './hooks';
import { RunPage } from './RunPage';

export function App() {
  const route = parseHash(useHash());
  return (
    <>
      <header className="top">
        <a href="#/" className="brand">
          Ziro — every paisa, accounted for
        </a>
        <span className="tag">synthetic data · Razorpay test mode</span>
      </header>
      <AgentBanner />
      <main>{route.page === 'home' ? <Home /> : <RunPage route={route} />}</main>
    </>
  );
}

/** Says so, on every page, while the agent is paused (kill switch, budget, key, provider limit, outage). */
function AgentBanner() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      get<AgentStatus>('/agent/status').then(
        (s) => live && setStatus(s),
        () => undefined,
      );
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const text = agentBanner(status);
  return text === null ? null : (
    <div className="banner warn" role="status">
      {text}
    </div>
  );
}

function Home() {
  const { data: offer } = useLoad<Availability>('/demo');
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

  return (
    <>
      <section className="lead">
        <h1>Reconcile a batch and watch every difference get explained</h1>
        <p>
          Ziro matches a merchant's ledger, Razorpay and the bank statement. Rules settle what they
          can prove, to the paise. An agent investigates the rest, a separate checker re-computes
          every claim, and a person approves. Click once to run it on 50 synthetic orders.
        </p>
        <div className="actions">
          <button className="primary" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Run demo batch (50 orders)'}
          </button>
          {offer?.featured.eval ? (
            <a className="button" href={linkTo(offer.featured.eval)}>
              Replay eval run (500 orders, free, no key needed)
            </a>
          ) : (
            <span className="button disabled">Eval run (500 orders) is still being prepared</span>
          )}
        </div>
        {offer?.live.available ? (
          <label className="check">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => {
                setLive(e.target.checked);
                if (e.target.checked) setChaos(false);
              }}
            />{' '}
            Use a live language model (costs money; off by default)
          </label>
        ) : null}
        {offer?.chaos.available ? (
          <label className="check">
            <input
              type="checkbox"
              checked={chaos}
              disabled={live}
              onChange={(e) => setChaos(e.target.checked)}
            />{' '}
            Break two investigations on purpose (a model timeout and a cut-off reply) and watch them
            handled. Free; uses the scripted agent.
          </label>
        ) : null}
        {problem ? <p className="bad">{problem}</p> : null}
      </section>

      <section className="note">
        <h2>What you are looking at, honestly</h2>
        <ul>
          <li>
            All data is <b>synthetic</b>, made by a seeded generator, shaped like Razorpay's
            documented records. Nothing here is a real customer or a real bank. Razorpay is used in{' '}
            <b>test mode</b> only.
          </li>
          <li>
            The free demo's agent is a <b>scripted baseline, not a language model</b>. It reads
            records through the same read-only tools a model would, and everything after it (the
            checker, the review queue, the audit trail) is the real code.
          </li>
          <li>
            The replay is a <b>precomputed, read-only</b> run of 500 synthetic orders. Opening it
            costs nothing and works with no API key. “Reset demo” (inside a run) puts your run away
            and starts a fresh one.
          </li>
          <li>
            Two proposals in each demo run are <b>planted on purpose</b>, confident and wrong, so
            you can see the checker refuse them. They are labelled wherever they appear.
          </li>
        </ul>
      </section>
    </>
  );
}
