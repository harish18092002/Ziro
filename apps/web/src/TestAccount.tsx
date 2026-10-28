import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type AgentStatus,
  type CsvReport,
  get,
  type MatchResult,
  post,
  reasonOf,
  type RazorpayReport,
  type RazorpayStatus,
  type StarterSummary,
  type TestPaymentList,
  upload,
} from './api';
import { linkTo, maskKeyId } from './format';
import { useLoad } from './hooks';
import { HowToPay } from './HowToPay';
import { Icon } from './Icons';
import { PaymentsPanel } from './PaymentsPanel';
import { SetupGuide } from './SetupGuide';
import { BANK_TEMPLATE, daysAgo, istDay, LEDGER_TEMPLATE } from './test-account';
import { Banner } from './ui';

// The test-account workspace: make payments in YOUR Razorpay test account, refund some, then reconcile them
// against a ledger (and, if you have one, a bank statement). Nothing here is generated: an empty account is
// shown as empty and the page says how to fill it.

type StepId = 'payments' | 'ledger' | 'bank' | 'match';

export function TestAccount() {
  const status = useLoad<RazorpayStatus>('/razorpay/status');
  const agent = useLoad<AgentStatus>('/agent/status');
  const [round, setRound] = useState(0);

  const ready = status.data?.ready === true && status.data.importsOpen;
  return (
    <div className="ta page">
      <header className="ta-head">
        <div>
          <span className="slash">Razorpay test mode · your data, nothing generated</span>
          <h1 className="serif">
            Reconcile your <em>test account.</em>
          </h1>
          <p className="muted">
            Make test payments, refund some, then reconcile them against your ledger. Real Razorpay
            test data: no real money moves. Want generated data instead?{' '}
            <a href="#/">Run the built-in demo</a>.
          </p>
        </div>
        {ready && status.data?.keyId ? (
          <span className="keychip" title="The public half of your test key">
            <Icon name="shield" size={14} /> Test mode · <code>{maskKeyId(status.data.keyId)}</code>
          </span>
        ) : null}
      </header>

      {status.data === null && status.error === null ? (
        <div className="skel" style={{ height: 220 }} />
      ) : status.error !== null ? (
        <Banner tone="bad" role="alert">
          Could not reach the server: {status.error}
        </Banner>
      ) : ready ? (
        <Workspace
          key={round}
          aiReady={agent.data?.configured === true && agent.data.paused === null}
          onStartOver={() => setRound((n) => n + 1)}
        />
      ) : (
        <SetupGuide status={status.data} />
      )}
    </div>
  );
}

function Workspace({ aiReady, onStartOver }: { aiReady: boolean; onStartOver: () => void }) {
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => istDay(new Date()));
  const [list, setList] = useState<TestPaymentList | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [imported, setImported] = useState<RazorpayReport | null>(null);
  const [starter, setStarter] = useState<StarterSummary | null>(null);
  const [ledger, setLedger] = useState<CsvReport | null>(null);
  const [bank, setBank] = useState<CsvReport | null>(null);
  const [bankSkipped, setBankSkipped] = useState(false);
  const [matched, setMatched] = useState<{ result: MatchResult; note: string | null } | null>(null);
  const [withAi, setWithAi] = useState(false);
  const [ledgerFile, setLedgerFile] = useState<File | null>(null);
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<StepId | null>(null);
  const [failure, setFailure] = useState<{ step: StepId; text: string } | null>(null);

  /** Runs one step, shows its failure under it, and never leaves the page in a half state. */
  const act = async (step: StepId, work: () => Promise<void>): Promise<void> => {
    setBusy(step);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure({ step, text: reasonOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const importPayments = () =>
    act('payments', async () => {
      let id = runId;
      if (id === null) {
        const run = await post<{ id: string }>('/runs', { periodStart: from, periodEnd: to });
        id = run.id;
        setRunId(id);
      }
      setImported(await post<RazorpayReport>(`/runs/${id}/import/razorpay`, { from, to }));
      setStarter(await get<StarterSummary>(`/runs/${id}/starter`));
    });

  const count = list?.payments.length ?? 0;
  const importedPayments = imported?.entities['payments']?.fetched ?? 0;
  const importedRefunds = imported?.entities['refunds']?.fetched ?? 0;
  const ledgerRows = ledger ? ledger.rows.inserted + ledger.rows.unchanged : 0;
  const bankRows = bank ? bank.rows.inserted + bank.rows.unchanged : 0;

  const states: Record<StepId, 'wait' | 'now' | 'done'> = {
    payments: imported ? 'done' : 'now',
    ledger: ledger ? 'done' : imported ? 'now' : 'wait',
    bank: bank || bankSkipped ? 'done' : ledger ? 'now' : 'wait',
    match: matched ? 'done' : ledger && (bank || bankSkipped) ? 'now' : 'wait',
  };

  return (
    <>
      <ol className="ta-rail" aria-label="Progress">
        {(
          [
            ['payments', 'Payments'],
            ['ledger', 'Ledger'],
            ['bank', 'Bank (optional)'],
            ['match', 'Reconcile'],
          ] as const
        ).map(([id, label], i) => (
          <li
            key={id}
            className={states[id]}
            aria-current={states[id] === 'now' ? 'step' : undefined}
          >
            <span className="rail-dot">
              {states[id] === 'done' ? <Icon name="check" size={13} /> : i + 1}
            </span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      {runId !== null ? (
        <p className="ta-restart">
          <button type="button" className="ghost sm" onClick={onStartOver}>
            <Icon name="refresh" size={14} /> Start over
          </button>
        </p>
      ) : null}

      <Step
        n={1}
        title="Get payments into your test account"
        state={states.payments}
        summary={
          imported
            ? `${importedPayments} ${importedPayments === 1 ? 'payment' : 'payments'}${importedRefunds > 0 ? `, ${importedRefunds} ${importedRefunds === 1 ? 'refund' : 'refunds'}` : ''} imported`
            : null
        }
      >
        {imported || count > 0 ? (
          <details className="fold">
            <summary>How to make {count > 0 ? 'more ' : ''}test payments</summary>
            <HowToPay />
          </details>
        ) : (
          <HowToPay />
        )}

        <PaymentsPanel
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
          locked={runId !== null}
          onList={setList}
        />

        <div className="actions">
          <button
            type="button"
            className="primary lg"
            disabled={busy !== null || count === 0 || from > to}
            onClick={() => void importPayments()}
          >
            {busy === 'payments' ? (
              <span className="spinner" />
            ) : (
              <Icon name="download" size={17} />
            )}{' '}
            {imported
              ? 'Import again'
              : count === 0
                ? 'Import payments and continue'
                : `Import ${count} ${count === 1 ? 'payment' : 'payments'} and continue`}
          </button>
          <p className="muted small grow">
            {count === 0 && !imported
              ? 'Make at least one payment first.'
              : imported
                ? 'Made more payments or refunds? Import again to add them.'
                : 'Copies these payments and their refunds into a new reconciliation. Nothing changes in your Razorpay account.'}
          </p>
        </div>
        {imported?.partial ? (
          <Banner tone="warn">
            <b>Only part of it arrived.</b> {imported.gaps.map((g) => g.detail).join('; ')}
          </Banner>
        ) : null}
        <Problem failure={failure} step="payments" />
      </Step>

      <Step
        n={2}
        title="Add your ledger"
        state={states.ledger}
        summary={ledger ? `${ledgerRows} ${ledgerRows === 1 ? 'order' : 'orders'}` : null}
      >
        <p>
          A ledger is your own list of the orders you expected to be paid. Razorpay does not have
          it, so Ziro needs it to check Razorpay against.
        </p>
        <div className="choices">
          <div className="choice">
            <h3>Start from your Razorpay orders</h3>
            <p className="muted">
              {starter === null
                ? 'Import the payments first.'
                : starter.ledger.rows === 0
                  ? 'No paid order to copy yet: make a captured payment first.'
                  : `Ziro can build a ledger from the ${starter.ledger.rows} paid ${starter.ledger.rows === 1 ? 'order' : 'orders'} it just imported. It will match every payment, so it shows the pipeline working. To see the matcher catch something, download it, change an amount or delete a row, then upload it.`}
            </p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={runId === null || !starter || starter.ledger.rows === 0 || busy !== null}
                onClick={() =>
                  void act('ledger', async () => {
                    if (runId === null) return;
                    setLedger(await post<CsvReport>(`/runs/${runId}/import/starter-ledger`));
                  })
                }
              >
                {busy === 'ledger' ? <span className="spinner" /> : <Icon name="check" size={16} />}{' '}
                Use this ledger
              </button>
              {runId !== null && starter && starter.ledger.rows > 0 ? (
                <a className="button ghost" href={`/runs/${runId}/starter-ledger.csv`} download>
                  <Icon name="download" size={16} /> Download to edit
                </a>
              ) : null}
            </div>
          </div>
          <div className="choice">
            <h3>Upload your own file</h3>
            <p className="muted">
              A CSV from your accounting system. Required columns: <code>order_ref</code>,{' '}
              <code>order_date</code> (DD-MM-YYYY) and <code>amount</code> in rupees. Optional:{' '}
              <code>customer_ref</code>, <code>memo</code>.
            </p>
            <div className="actions">
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Ledger CSV file"
                onChange={(e) => setLedgerFile(e.target.files?.[0] ?? null)}
              />
              <button
                type="button"
                disabled={
                  runId === null || imported === null || ledgerFile === null || busy !== null
                }
                onClick={() =>
                  void act('ledger', async () => {
                    if (runId === null || ledgerFile === null) return;
                    setLedger(await upload<CsvReport>(`/runs/${runId}/import/ledger`, ledgerFile));
                  })
                }
              >
                <Icon name="upload" size={16} /> Upload
              </button>
            </div>
            <DownloadLink filename="ledger-template.csv" text={LEDGER_TEMPLATE}>
              Download a blank template
            </DownloadLink>
          </div>
        </div>
        <ImportResult report={ledger} noun="orders" />
        <Problem failure={failure} step="ledger" />
      </Step>

      <Step
        n={3}
        title="Add a bank statement (optional)"
        state={states.bank}
        summary={bank ? `${bankRows} lines` : bankSkipped ? 'skipped' : null}
      >
        <p>
          Razorpay test mode does not pay out to a real bank, so there is no statement to import.
          You can skip this step: payments, refunds and fees still reconcile, and payouts are left
          open.
        </p>
        <div className="actions">
          <button
            type="button"
            className={bank ? 'ghost' : 'primary'}
            disabled={ledger === null || bank !== null}
            onClick={() => setBankSkipped(true)}
          >
            Skip the bank statement
          </button>
          {starter !== null && starter.bank.rows > 0 ? (
            <button
              type="button"
              disabled={runId === null || ledger === null || busy !== null}
              onClick={() =>
                void act('bank', async () => {
                  if (runId === null) return;
                  setBank(await post<CsvReport>(`/runs/${runId}/import/simulated-bank`));
                  setBankSkipped(false);
                })
              }
            >
              Simulate it from {starter.bank.rows}{' '}
              {starter.bank.rows === 1 ? 'settlement' : 'settlements'}
            </button>
          ) : null}
        </div>
        <details className="fold">
          <summary>I have a statement to upload</summary>
          <p className="muted">
            Columns: <code>value_date</code> (DD/MM/YYYY), <code>narration</code>,{' '}
            <code>debit</code>, <code>credit</code>, <code>balance</code>.
          </p>
          <div className="actions">
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Bank statement CSV file"
              onChange={(e) => setBankFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              disabled={runId === null || ledger === null || bankFile === null || busy !== null}
              onClick={() =>
                void act('bank', async () => {
                  if (runId === null || bankFile === null) return;
                  setBank(await upload<CsvReport>(`/runs/${runId}/import/bank`, bankFile));
                  setBankSkipped(false);
                })
              }
            >
              <Icon name="upload" size={16} /> Upload
            </button>
          </div>
          <DownloadLink filename="bank-template.csv" text={BANK_TEMPLATE}>
            Download a blank template
          </DownloadLink>
        </details>
        <ImportResult report={bank} noun="bank lines" />
        <Problem failure={failure} step="bank" />
      </Step>

      <Step
        n={4}
        title="Reconcile"
        state={states.match}
        summary={
          matched
            ? `${matched.result.groups} matched, ${matched.result.exceptions} to look at`
            : null
        }
        action={
          matched !== null && runId !== null ? (
            <a className="button primary sm" href={linkTo(runId)}>
              Open the results <Icon name="arrow" size={14} />
            </a>
          ) : null
        }
      >
        <p>
          Ziro matches your ledger to Razorpay, to the paisa. Anything it cannot prove becomes an
          exception for you to review.
        </p>
        {aiReady ? (
          <label className="switch">
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            <span className="track" />
            <span className="words">
              <b>Also ask the AI to investigate the exceptions</b>
              <span>Uses free-tier requests. Off by default.</span>
            </span>
          </label>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="primary lg"
            disabled={runId === null || busy !== null || matched !== null}
            onClick={() =>
              void act('match', async () => {
                if (runId === null) return;
                const result = await post<MatchResult>(`/runs/${runId}/match`);
                let note: string | null = null;
                if (withAi && aiReady && result.exceptions > 0) {
                  try {
                    await post(`/runs/${runId}/investigate`);
                  } catch (error) {
                    note = `The AI could not start: ${reasonOf(error)}`;
                  }
                }
                setMatched({ result, note });
                // Straight to the results, unless there is a note to read here first.
                if (note === null) window.location.hash = linkTo(runId);
              })
            }
          >
            {busy === 'match' ? <span className="spinner" /> : <Icon name="bolt" size={17} />}{' '}
            Reconcile
          </button>
          {matched !== null && runId !== null ? (
            <a className="button primary lg" href={linkTo(runId)}>
              Open the results <Icon name="arrow" size={16} />
            </a>
          ) : null}
        </div>
        {matched?.note ? <Banner tone="warn">{matched.note}</Banner> : null}
        <Problem failure={failure} step="match" />
      </Step>
    </>
  );
}

function Step({
  n,
  title,
  state,
  summary,
  action = null,
  children,
}: {
  n: number;
  title: string;
  state: 'wait' | 'now' | 'done';
  summary: string | null;
  /** Shown on the folded line of a finished step, beside Change. */
  action?: ReactNode;
  children: ReactNode;
}) {
  // A finished step folds to one line; it can be opened again (to import again, or change a file).
  const [open, setOpen] = useState(false);
  const shown = state === 'now' || (state === 'done' && open);
  const bodyId = `wstep-${n}`;
  return (
    <section className={`wstep ${state} ${shown ? 'open' : ''}`}>
      <span className="wnum" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={15} /> : n}
      </span>
      <div className="wbody">
        <div className="whead">
          <h2>
            {title}
            {summary ? <span className="wsum"> · {summary}</span> : null}
          </h2>
          {state === 'done' ? (
            <span className="wactions">
              {open ? null : action}
              <button
                type="button"
                className="ghost sm"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen((v) => !v)}
              >
                {open ? 'Hide' : 'Change'}
              </button>
            </span>
          ) : null}
        </div>
        {state === 'wait' ? (
          <p className="muted">Unlocks after step {n - 1}.</p>
        ) : shown ? (
          <div id={bodyId} className="wcontent">
            {children}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Problem({
  failure,
  step,
}: {
  failure: { step: StepId; text: string } | null;
  step: StepId;
}) {
  return failure?.step === step ? (
    <Banner tone="bad" role="alert">
      {failure.text}
    </Banner>
  ) : null;
}

function ImportResult({ report, noun }: { report: CsvReport | null; noun: string }) {
  if (report === null) return null;
  const read = report.rows.inserted + report.rows.unchanged;
  return (
    <div className="result-note">
      <p>
        <Icon name="check" size={15} />
        <span>
          Read {read} {noun} from <code>{report.fileName ?? 'the file'}</code>
          {report.rows.rejected > 0 ? `; ${report.rows.rejected} rows were refused` : ''}.
        </span>
      </p>
      {report.errors.slice(0, 4).map((e) => (
        <p className="bad-text" key={`${e.row}-${e.field}`}>
          Row {e.row}
          {e.field ? ` (${e.field})` : ''}: {e.reason}
        </p>
      ))}
    </div>
  );
}

/** A file made in the browser, offered for download. Revoked when it goes away. */
function DownloadLink({
  filename,
  text,
  children,
}: {
  filename: string;
  text: string;
  children: ReactNode;
}) {
  const url = useMemo(() => URL.createObjectURL(new Blob([text], { type: 'text/csv' })), [text]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <a className="linkish" href={url} download={filename}>
      <Icon name="download" size={14} /> {children}
    </a>
  );
}
