import { useEffect, useState } from 'react';
import { get, type Overview, type Progress } from './api';
import { AuditTab } from './Audit';
import { ExceptionsTab } from './Exceptions';
import { dollars, inr, linkTo, percent, type Route, type Tab, words } from './format';

type RunRoute = Extract<Route, { page: 'run' }>;

const TAB_NAMES: Record<Tab, string> = {
  summary: 'Summary',
  exceptions: 'Exceptions',
  audit: 'Audit',
  downloads: 'Downloads',
};

export function RunPage({ route }: { route: RunRoute }) {
  const progress = useProgress(route.runId);
  if (progress === null) return <p className="muted">Loading…</p>;
  if (progress.stage === 'failed')
    return <p className="bad">This run failed: {progress.error ?? 'no reason recorded'}.</p>;
  if (progress.stage !== 'ready' && progress.stage !== 'unknown') return <Working p={progress} />;

  return (
    <>
      <nav className="tabs">
        {(Object.keys(TAB_NAMES) as Tab[]).map((t) => (
          <a key={t} href={linkTo(route.runId, t)} className={t === route.tab ? 'on' : ''}>
            {TAB_NAMES[t]}
          </a>
        ))}
      </nav>
      {route.tab === 'summary' && <Summary runId={route.runId} />}
      {route.tab === 'exceptions' && <ExceptionsTab runId={route.runId} selected={route.itemId} />}
      {route.tab === 'audit' && <AuditTab runId={route.runId} selected={route.itemId} />}
      {route.tab === 'downloads' && <Downloads runId={route.runId} />}
    </>
  );
}

/** Polls a run until it is ready (or failed), then stops. */
function useProgress(runId: string): Progress | null {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await get<Progress>(`/runs/${runId}/progress`);
        if (!live) return;
        setP(next);
        if (next.stage === 'matching' || next.stage === 'investigating')
          timer = setTimeout(() => void tick(), 600);
      } catch {
        if (live) timer = setTimeout(() => void tick(), 2_000);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);
  return p;
}

function Working({ p }: { p: Progress }) {
  const steps = [
    ['matching', 'Rules match what they can prove, to the paise'],
    ['investigating', 'The agent investigates what is left; the checker re-computes every claim'],
  ] as const;
  return (
    <section className="working">
      <h1>Working…</h1>
      <ol>
        {steps.map(([stage, label]) => (
          <li
            key={stage}
            className={stage === p.stage ? 'now' : stage === 'matching' ? 'done' : ''}
          >
            {label}
          </li>
        ))}
      </ol>
      <p>
        {p.counts.groups} groups proved · {p.counts.exceptions} exceptions
        {p.expected !== null ? ` · ${p.counts.proposals} of ${p.expected} investigated` : ''} ·{' '}
        {p.counts.refused} refused by the checker
      </p>
      <progress max={p.expected ?? 1} value={p.expected ? p.counts.proposals : 0} />
    </section>
  );
}

function Summary({ runId }: { runId: string }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<Overview>(`/runs/${runId}/overview`).then(setO, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [runId]);
  if (error) return <p className="bad">{error}</p>;
  if (o === null) return <p className="muted">Loading…</p>;
  const { gap, sources: s } = o;

  return (
    <>
      <section className="gap">
        <div>
          <div className="label">The Ziro gap: still unreconciled</div>
          <div className="big">{inr(gap.gapPaise)}</div>
          <div className="muted">
            goal: ₹0.00 unexplained · {inr(gap.openPaise)} not yet looked at ({gap.cases.open}{' '}
            cases) · {inr(gap.awaitingPaise)} waiting for a person ({gap.cases.awaiting} cases)
          </div>
        </div>
        <div>
          <div className="label">Explained so far</div>
          <div className="big ok">{inr(gap.explainedPaise)}</div>
          <div className="muted">{gap.cases.explained} cases settled by a person</div>
        </div>
      </section>

      <div className="cols">
        <section>
          <h2>Totals per source</h2>
          <table>
            <tbody>
              <tr>
                <td>Ledger</td>
                <td className="n">{s.ledger.records} entries</td>
                <td className="n">{inr(s.ledger.amountPaise)}</td>
              </tr>
              <tr>
                <td>Razorpay payments captured</td>
                <td className="n">
                  {s.payments.captured} of {s.payments.records}
                </td>
                <td className="n">{inr(s.payments.capturedPaise)}</td>
              </tr>
              <tr>
                <td>Fees incl. GST</td>
                <td />
                <td className="n">{inr(s.payments.feesPaise)}</td>
              </tr>
              <tr>
                <td>Refunds</td>
                <td className="n">{s.refunds.records}</td>
                <td className="n">{inr(s.refunds.amountPaise)}</td>
              </tr>
              <tr>
                <td>Settlements</td>
                <td className="n">{s.settlements.records}</td>
                <td className="n">{inr(s.settlements.amountPaise)}</td>
              </tr>
              <tr>
                <td>Bank credits</td>
                <td className="n">{s.bank.credits.records}</td>
                <td className="n">{inr(s.bank.credits.amountPaise)}</td>
              </tr>
              <tr>
                <td>Bank debits</td>
                <td className="n">{s.bank.debits.records}</td>
                <td className="n">{inr(s.bank.debits.amountPaise)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>Match rate by tier</h2>
          <table>
            <thead>
              <tr>
                <th>How it was matched</th>
                <th className="n">Groups</th>
                <th className="n">Records</th>
                <th className="n">Share</th>
              </tr>
            </thead>
            <tbody>
              {o.matching.byTier.map((t) => (
                <tr key={t.label}>
                  <td>{t.label}</td>
                  <td className="n">{t.groups}</td>
                  <td className="n">{t.records}</td>
                  <td className="n">{percent(t.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th className="n">Matched</th>
                <th className="n">In exception</th>
                <th className="n">Ignored</th>
                <th className="n">Rate</th>
              </tr>
            </thead>
            <tbody>
              {o.coverage.map((c) => (
                <tr key={c.type}>
                  <td>{words(c.type)}</td>
                  <td className="n">{c.matched}</td>
                  <td className="n">{c.inException}</td>
                  <td className="n">{c.ignored}</td>
                  <td className="n">{percent(c.matchRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Rate = matched ÷ (matched + in an exception). “Ignored” are records no rule should
            match, such as failed payments and bank debits.
          </p>
        </section>
      </div>

      <div className="cols">
        <section>
          <h2>Exceptions by reason</h2>
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th className="n">Total</th>
                <th className="n">Open</th>
                <th className="n">Waiting</th>
                <th className="n">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {o.exceptionsByReason.map((r) => (
                <tr key={r.reasonCode}>
                  <td>
                    <a href={`${linkTo(runId, 'exceptions')}`}>{words(r.reasonCode)}</a>
                  </td>
                  <td className="n">{r.total}</td>
                  <td className="n">{r.open}</td>
                  <td className="n">{r.proposed}</td>
                  <td className="n">{r.resolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Agent cost and time</h2>
          <table>
            <tbody>
              <tr>
                <td>Agent</td>
                <td className="n">
                  {o.llm.agent === 'scripted'
                    ? 'scripted baseline (not a language model)'
                    : (o.llm.agent ?? 'none')}
                </td>
              </tr>
              <tr>
                <td>Model calls</td>
                <td className="n">{o.llm.calls}</td>
              </tr>
              <tr>
                <td>Model cost</td>
                <td className="n">{dollars(o.llm.costUsd)}</td>
              </tr>
              <tr>
                <td>Wall time for the run</td>
                <td className="n">{o.time.seconds === null ? '–' : `${o.time.seconds} s`}</td>
              </tr>
              <tr>
                <td>Approved by a person</td>
                <td className="n">{o.matching.approvedByPerson}</td>
              </tr>
            </tbody>
          </table>
          <p>
            <a className="button" href={linkTo(runId, 'exceptions')}>
              Review the exceptions →
            </a>
          </p>
        </section>
      </div>
    </>
  );
}

function Downloads({ runId }: { runId: string }) {
  const files = [
    [
      'report.json',
      'Run report (JSON)',
      'Everything on the summary, every exception and the journal entries.',
    ],
    ['report.csv', 'Run report (CSV)', 'The summary as rows a spreadsheet can read.'],
    [
      'exceptions.csv',
      'Exceptions (CSV)',
      'One row per exception with the agent’s proposal, the checker’s verdict and any decision.',
    ],
    [
      'journal-entries.csv',
      'Journal entries (CSV)',
      'Draft entries for the books. Each balances to the paise; a person still posts them.',
    ],
  ] as const;
  return (
    <section>
      <h2>Downloads</h2>
      <ul className="files">
        {files.map(([name, title, text]) => (
          <li key={name}>
            <a className="button" href={`/runs/${runId}/${name}`} download>
              {title}
            </a>
            <span className="muted"> {text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
