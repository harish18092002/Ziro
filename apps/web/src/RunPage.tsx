import { useEffect, useState } from 'react';
import { ApiError, get, type Overview, type Progress, post } from './api';
import { AuditTab } from './Audit';
import { ExceptionsTab } from './Exceptions';
import {
  dollars,
  failureSentence,
  inr,
  linkTo,
  percent,
  type Route,
  type Tab,
  words,
} from './format';
import { useLoad } from './hooks';

type RunRoute = Extract<Route, { page: 'run' }>;

const TAB_NAMES: Record<Tab, string> = {
  summary: 'Summary',
  exceptions: 'Exceptions',
  audit: 'Audit',
  downloads: 'Downloads',
};

export function RunPage({ route }: { route: RunRoute }) {
  const progress = useProgress(route.runId);
  // One overview for the banners above the tabs and for the Summary tab.
  const overview = useLoad<Overview>(
    progress?.stage === 'ready' || progress?.stage === 'unknown'
      ? `/runs/${route.runId}/overview`
      : null,
  );
  if (progress === null) return <p className="muted">Loading…</p>;
  if (progress.stage === 'failed')
    return <p className="bad">This run failed: {progress.error ?? 'no reason recorded'}.</p>;
  if (progress.stage !== 'ready' && progress.stage !== 'unknown') return <Working p={progress} />;

  return (
    <>
      {overview.data ? <RunBanners o={overview.data} runId={route.runId} /> : null}
      <nav className="tabs">
        {(Object.keys(TAB_NAMES) as Tab[]).map((t) => (
          <a key={t} href={linkTo(route.runId, t)} className={t === route.tab ? 'on' : ''}>
            {TAB_NAMES[t]}
          </a>
        ))}
        {overview.data && overview.data.run.featured === null ? (
          <ResetDemo runId={route.runId} />
        ) : null}
      </nav>
      {route.tab === 'summary' && (
        <Summary runId={route.runId} o={overview.data} error={overview.error} />
      )}
      {route.tab === 'exceptions' && (
        <ExceptionsTab
          runId={route.runId}
          selected={route.itemId}
          readOnly={
            overview.data !== null &&
            (overview.data.run.featured !== null || overview.data.run.archived)
          }
        />
      )}
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

/** Archives this run and starts a fresh scripted one; the server keeps the old rows (the audit trail is append-only). */
function ResetDemo({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reset = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { runId: fresh } = await post<{ runId: string }>('/demo/reset', { runId });
      window.location.hash = linkTo(fresh);
    } catch (e) {
      setBusy(false);
      setProblem(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span className="reset">
      <button disabled={busy} onClick={() => void reset()}>
        {busy ? 'Resetting…' : 'Reset demo'}
      </button>
      {problem ? <span className="bad"> {problem}</span> : null}
    </span>
  );
}

/**
 * What a person must know before reading any number on this run: Razorpay did not return everything
 * (PARTIAL), the agent stopped early, or the demo broke things on purpose. Shown on every tab.
 */
function RunBanners({ o, runId }: { o: Overview; runId: string }) {
  const handled = failureSentence(o.failures);
  return (
    <>
      {o.run.featured !== null ? (
        <div className="banner info" role="status">
          <b>Replay.</b> This is a precomputed run, shown read-only: it costs nothing and needs no
          API key. <a href="#/">Start your own run</a> to approve or reject proposals.
        </div>
      ) : null}
      {o.run.archived ? (
        <div className="banner warn" role="status">
          <b>Archived.</b> This run was put away by “Reset demo”. You can still read it, but it can
          no longer be approved or rejected. <a href="#/">Start a new run</a>.
        </div>
      ) : null}
      {o.run.partial ? (
        <div className="banner warn" role="alert">
          <b>PARTIAL RUN.</b> Razorpay did not return everything. What arrived was imported; this is
          missing:
          <ul>
            {o.run.gaps.map((g, i) => (
              <li key={i}>{g.detail}</li>
            ))}
          </ul>
          Exceptions such as “ledger without payment” or an unexplained settlement may be caused by
          the gap, not by a real discrepancy. Import again to fill in what is missing.
        </div>
      ) : null}
      {o.failures.note ? (
        <div className="banner warn" role="status">
          {o.failures.note}. The exceptions it left are still open.
        </div>
      ) : null}
      {o.failures.injected ? (
        <div className="banner info" role="status">
          <b>Chaos is on.</b> The demo broke three investigations on purpose: one where every model
          timed out, one where every model was out of quota, and one where a reply was cut off
          mid-JSON. {handled ?? ''} Nothing stopped: the run finished and all three went to a person
          with the reason. In <a href={linkTo(runId, 'exceptions')}>Exceptions</a>, the filter
          “Handed to a person by the system” shows them.
        </div>
      ) : handled ? (
        <div className="banner info" role="status">
          {handled}
        </div>
      ) : null}
    </>
  );
}

function Summary({ runId, o, error }: { runId: string; o: Overview | null; error: string | null }) {
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
                <td>Handed to a person without a conclusion</td>
                <td className="n">{o.failures.handedToAPerson}</td>
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

      <section>
        <h2>
          Do the totals add up?{' '}
          {o.reconciles ? (
            <span className="pill ok">yes, to the paise</span>
          ) : (
            <span className="pill bad">NO</span>
          )}
        </h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th className="n">Matched</th>
              <th className="n">In an exception</th>
              <th className="n">Ignored</th>
              <th className="n">Total</th>
            </tr>
          </thead>
          <tbody>
            {o.coverage.map((c) => (
              <tr key={c.type}>
                <td>{words(c.type)}</td>
                <td className="n">{inr(c.amountPaise.matched)}</td>
                <td className="n">{inr(c.amountPaise.inException)}</td>
                <td className="n">{inr(c.amountPaise.ignored)}</td>
                <td className="n">
                  {inr(c.amountPaise.total)} {c.reconciles ? '✓' : '✗'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Each record is in exactly one place: a proven group, an exception, or ignored (failed
          payments, bank debits, credits that are not Razorpay payouts). Counted separately, so a
          row that did not add up would show ✗.
        </p>
      </section>

      <div className="cols">
        <section>
          <h2>How things were settled</h2>
          <table>
            <tbody>
              <tr>
                <td>Rule groups (proved by code)</td>
                <td className="n">{o.resolution.ruleGroups}</td>
              </tr>
              <tr>
                <td>Agent match, approved by a person</td>
                <td className="n">{o.resolution.agentMatchesApprovedByPerson}</td>
              </tr>
              <tr>
                <td>Agent explanation, approved by a person</td>
                <td className="n">{o.resolution.agentExplanationsApprovedByPerson}</td>
              </tr>
              <tr>
                <td>Agent proposal, auto-accepted</td>
                <td className="n">{o.resolution.autoAccepted}</td>
              </tr>
              <tr>
                <td>Proposal rejected by a person</td>
                <td className="n">{o.resolution.rejectedByPerson}</td>
              </tr>
              <tr>
                <td>Waiting for a person</td>
                <td className="n">{o.resolution.waiting}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section>
          <h2>Unsettled by age</h2>
          <table>
            <thead>
              <tr>
                <th>As of {o.openExceptions.asOf}</th>
                <th className="n">Cases</th>
                <th className="n">At stake</th>
              </tr>
            </thead>
            <tbody>
              {o.openExceptions.byAge.map((b) => (
                <tr key={b.bucket}>
                  <td>{b.bucket}</td>
                  <td className="n">{b.cases}</td>
                  <td className="n">{inr(b.stakePaise)}</td>
                </tr>
              ))}
              {o.openExceptions.byAge.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    Nothing unsettled.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="muted">
            Age is counted from the record's own date to the run's as-of date, not from today.
          </p>
        </section>
      </div>

      <div className="cols">
        <section>
          <h2>Fee leakage</h2>
          <div className="big">{inr(o.leakage.excessPaise)}</div>
          <p className="muted">
            charged above the contract on {o.leakage.overchargedCount} of {o.leakage.assessed}{' '}
            payments (base fee {inr(o.leakage.excessBasePaise)} + GST{' '}
            {inr(o.leakage.excessGstPaise)}).
            {o.leakage.contract.source === 'default'
              ? ' The run stored no fee contract, so the default was used.'
              : ''}
            {o.leakage.notAssessable > 0
              ? ` ${o.leakage.notAssessable} payments could not be judged (method or currency not in the contract).`
              : ''}
            {o.leakage.undercharged.count > 0
              ? ` Separately, ${o.leakage.undercharged.count} were charged ${inr(o.leakage.undercharged.shortfallPaise)} below the contract; that is not netted.`
              : ''}
          </p>
          <table>
            <thead>
              <tr>
                <th>Largest</th>
                <th>Method</th>
                <th className="n">Expected</th>
                <th className="n">Charged</th>
                <th className="n">Excess</th>
              </tr>
            </thead>
            <tbody>
              {o.leakage.worst.slice(0, 5).map((w) => (
                <tr key={w.rzpId}>
                  <td>{w.rzpId}</td>
                  <td>{w.method}</td>
                  <td className="n">{inr(w.expectedFeePaise)}</td>
                  <td className="n">{inr(w.actualFeePaise)}</td>
                  <td className="n">{inr(w.excessPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2>Delayed settlements</h2>
          <div className="big">{o.delays.delayedCount}</div>
          <p className="muted">
            settlements worth {inr(o.delays.delayedPaise)} arrived later than the normal lag.{' '}
            {o.delays.overdueCount > 0
              ? `${o.delays.overdueCount} (${inr(o.delays.overduePaise)}) have no bank credit yet and are overdue.`
              : 'None is overdue.'}
          </p>
          <table>
            <thead>
              <tr>
                <th>Settlement</th>
                <th>Due</th>
                <th>Created</th>
                <th className="n">Days late</th>
                <th className="n">Amount</th>
              </tr>
            </thead>
            <tbody>
              {o.delays.delayed.map((d) => (
                <tr key={d.rzpId}>
                  <td>{d.rzpId}</td>
                  <td>{d.dueDate ?? '–'}</td>
                  <td>{d.settlementDate}</td>
                  <td className="n">{d.createdLate ? d.businessDaysLate : 'credit late'}</td>
                  <td className="n">{inr(d.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2>Books</h2>
        <p>
          {o.journal.settlementsBooked} settlements are booked as {o.journal.vouchers} vouchers
          {o.journal.adjustmentsBooked > 0
            ? `, including ${o.journal.adjustmentsBooked} adjustments a person approved`
            : ''}
          . {o.journal.settlementsNotBooked.count} ({inr(o.journal.settlementsNotBooked.paise)})
          cannot be booked yet: no bank credit has been matched to them.{' '}
          <a href={linkTo(runId, 'downloads')}>Download the vouchers →</a>
        </p>
      </section>
    </>
  );
}

function Downloads({ runId }: { runId: string }) {
  const files = [
    [
      'report.json',
      'Run report (JSON)',
      'Everything on the summary, every exception and every voucher, in integer paise.',
    ],
    ['report.csv', 'Run report (CSV)', 'The summary as rows a spreadsheet can read.'],
    [
      'exceptions.csv',
      'Exceptions (CSV)',
      'One row per exception with its age, the suggested action, the next step, the checker’s verdict and any decision.',
    ],
    [
      'journal-entries.csv',
      'Journal entries (CSV)',
      'Vouchers for the books: date, voucher type, debit ledger, credit ledger, amount, narration with record ids. Fees, GST on fees, refunds and chargebacks.',
    ],
    [
      'journal-lines.csv',
      'Journal lines for Tally (CSV)',
      'The same vouchers, one row per ledger line, the layout TallyPrime’s Import Data from Excel maps. Open in Excel and save as .xlsx first.',
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
