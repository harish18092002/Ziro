import { type ReactNode, useState } from 'react';
import {
  ApiError,
  type AgentStatus,
  type CsvReport,
  type MatchResult,
  post,
  type RazorpayReport,
  type RazorpayStatus,
  type StarterSummary,
  upload,
  get,
} from './api';
import { linkTo } from './format';
import { useLoad } from './hooks';
import { Icon } from './Icons';
import { Banner } from './ui';

// A reconciliation from your own Razorpay TEST account, step by step: pick the dates, fetch what the account
// holds, give it a ledger, optionally a bank statement, and reconcile. Nothing here is generated: if the
// account is empty, the page says so and points at the page that makes test payments.

const isoDay = (date: Date): string => date.toLocaleDateString('en-CA');
const daysAgo = (n: number): string => isoDay(new Date(Date.now() - n * 86_400_000));

/** What to tell a person: a rejected file's own reasons, else the server's message. */
function reasonOf(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { fatal?: string[] } | null;
    if (Array.isArray(body?.fatal) && body.fatal.length > 0) return body.fatal.join('; ');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

type StepId = 'run' | 'razorpay' | 'ledger' | 'bank' | 'match';

export function NewRun() {
  const status = useLoad<RazorpayStatus>('/razorpay/status');
  const agent = useLoad<AgentStatus>('/agent/status');

  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [runId, setRunId] = useState<string | null>(null);
  const [fetched, setFetched] = useState<RazorpayReport | null>(null);
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

  const refreshStarter = async (id: string): Promise<void> => {
    setStarter(await get<StarterSummary>(`/runs/${id}/starter`));
  };

  if (status.data === null && status.error === null) {
    return <div className="skel" style={{ height: 220 }} />;
  }
  if (status.data?.ready !== true || status.data.importsOpen !== true) {
    return <NotAvailable status={status.data} error={status.error} />;
  }

  const paymentsFetched = fetched?.entities['payments']?.fetched ?? 0;
  const settlementsFetched = fetched?.entities['settlements']?.fetched ?? 0;
  const aiReady = agent.data?.configured === true && agent.data.paused === null;

  return (
    <div className="wizard page">
      <header className="wizard-head">
        <h1>Reconcile your Razorpay test account</h1>
        <p className="muted">
          Real test-mode data from Razorpay, matched against a ledger and, if you have one, a bank
          statement. Key {status.data.keyId}. No real money moves.
        </p>
      </header>

      <Step
        n={1}
        title="Choose the dates"
        state={runId ? 'done' : 'now'}
        summary={runId ? `${from} to ${to}` : null}
      >
        <div className="field-row">
          <label>
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to}
              disabled={runId !== null}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from}
              disabled={runId !== null}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={runId !== null || busy !== null || from === '' || to === '' || from > to}
            onClick={() =>
              void act('run', async () => {
                const run = await post<{ id: string }>('/runs', {
                  periodStart: from,
                  periodEnd: to,
                });
                setRunId(run.id);
              })
            }
          >
            {busy === 'run' ? <span className="spinner" /> : null} Start
          </button>
        </div>
        <Problem failure={failure} step="run" />
      </Step>

      <Step
        n={2}
        title="Fetch your test data from Razorpay"
        state={fetched ? 'done' : runId ? 'now' : 'wait'}
        summary={
          fetched
            ? `${paymentsFetched} payments, ${fetched.entities['refunds']?.fetched ?? 0} refunds, ${settlementsFetched} settlements`
            : null
        }
      >
        <p>
          Reads the orders, payments and refunds in your Razorpay test account for these dates, and
          nothing else.
        </p>
        <div className="actions">
          <button
            className="primary"
            disabled={runId === null || busy !== null}
            onClick={() =>
              void act('razorpay', async () => {
                if (runId === null) return;
                setFetched(
                  await post<RazorpayReport>(`/runs/${runId}/import/razorpay`, { from, to }),
                );
                await refreshStarter(runId);
              })
            }
          >
            {busy === 'razorpay' ? (
              <span className="spinner" />
            ) : (
              <Icon name="download" size={16} />
            )}{' '}
            {fetched ? 'Fetch again' : 'Fetch from Razorpay'}
          </button>
          <a className="button" href="/pay.html" target="_blank" rel="noreferrer">
            <Icon name="rupee" size={16} /> Make test payments
          </a>
        </div>
        {fetched && paymentsFetched === 0 ? (
          <Banner tone="warn">
            Your test account has no payments in these dates. Make a few on the test-payments page,
            then fetch again. Nothing is made up to fill the gap.
          </Banner>
        ) : null}
        {fetched?.partial ? (
          <Banner tone="warn">
            <b>Partly fetched.</b> {fetched.gaps.map((g) => g.detail).join('; ')}
          </Banner>
        ) : null}
        {fetched && paymentsFetched > 0 && settlementsFetched === 0 ? (
          <p className="muted">
            No settlements: Razorpay test mode does not pay out, so there is nothing to match to a
            bank. That is normal.
          </p>
        ) : null}
        <Problem failure={failure} step="razorpay" />
      </Step>

      <Step
        n={3}
        title="Give it a ledger"
        state={ledger ? 'done' : fetched ? 'now' : 'wait'}
        summary={ledger ? `${ledger.rows.inserted + ledger.rows.unchanged} orders` : null}
      >
        <p>
          The ledger is your own list of orders. Razorpay does not have it, so it comes from you.
        </p>
        <div className="choices">
          <div className="choice">
            <h3>Build it from the Razorpay orders</h3>
            <p className="muted">
              {starter === null
                ? 'Fetch the Razorpay data first.'
                : starter.ledger.rows === 0
                  ? 'No paid order to copy yet.'
                  : `${starter.ledger.rows} paid orders found. It matches by construction, so edit it first if you want something to find.`}
            </p>
            <div className="actions">
              <button
                disabled={
                  runId === null || starter === null || starter.ledger.rows === 0 || busy !== null
                }
                onClick={() =>
                  void act('ledger', async () => {
                    if (runId === null) return;
                    setLedger(await post<CsvReport>(`/runs/${runId}/import/starter-ledger`));
                  })
                }
              >
                {busy === 'ledger' ? <span className="spinner" /> : <Icon name="check" size={16} />}{' '}
                Use as it is
              </button>
              {runId !== null && starter !== null && starter.ledger.rows > 0 ? (
                <a className="button ghost" href={`/runs/${runId}/starter-ledger.csv`} download>
                  <Icon name="download" size={16} /> Download to edit
                </a>
              ) : null}
            </div>
          </div>
          <div className="choice">
            <h3>Upload your own CSV</h3>
            <p className="muted">
              Columns <code>order_ref</code>, <code>order_date</code> (DD-MM-YYYY) and{' '}
              <code>amount</code>; <code>customer_ref</code> and <code>memo</code> are optional.
            </p>
            <div className="actions">
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Ledger CSV file"
                onChange={(e) => setLedgerFile(e.target.files?.[0] ?? null)}
              />
              <button
                disabled={
                  runId === null || fetched === null || ledgerFile === null || busy !== null
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
          </div>
        </div>
        <ImportResult report={ledger} noun="orders" />
        <Problem failure={failure} step="ledger" />
      </Step>

      <Step
        n={4}
        title="Add a bank statement (optional)"
        state={bank || bankSkipped ? 'done' : ledger ? 'now' : 'wait'}
        summary={
          bank
            ? `${bank.rows.inserted + bank.rows.unchanged} lines`
            : bankSkipped
              ? 'skipped'
              : null
        }
      >
        <p>
          Razorpay test mode moves no money, so there is no real bank statement. Upload one you
          wrote, or go on without it: orders and payments still reconcile, and payouts wait.
        </p>
        <div className="actions">
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Bank statement CSV file"
            onChange={(e) => setBankFile(e.target.files?.[0] ?? null)}
          />
          <button
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
          {starter !== null && starter.bank.rows > 0 ? (
            <button
              disabled={runId === null || ledger === null || busy !== null}
              onClick={() =>
                void act('bank', async () => {
                  if (runId === null) return;
                  setBank(await post<CsvReport>(`/runs/${runId}/import/simulated-bank`));
                  setBankSkipped(false);
                })
              }
            >
              Simulate from {starter.bank.rows} settlements
            </button>
          ) : null}
          <button
            className="ghost"
            disabled={ledger === null || bank !== null}
            onClick={() => setBankSkipped(true)}
          >
            Skip it
          </button>
        </div>
        <p className="muted">
          Columns <code>value_date</code> (DD/MM/YYYY), <code>narration</code>, <code>debit</code>,{' '}
          <code>credit</code>, <code>balance</code>.
        </p>
        <ImportResult report={bank} noun="bank lines" />
        <Problem failure={failure} step="bank" />
      </Step>

      <Step
        n={5}
        title="Reconcile"
        state={matched ? 'done' : ledger ? 'now' : 'wait'}
        summary={
          matched
            ? `${matched.result.groups} groups, ${matched.result.exceptions} exceptions`
            : null
        }
      >
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
            className="primary lg"
            disabled={runId === null || ledger === null || busy !== null || matched !== null}
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
              })
            }
          >
            {busy === 'match' ? <span className="spinner" /> : <Icon name="bolt" size={17} />}{' '}
            {bank === null ? 'Reconcile without a bank statement' : 'Reconcile'}
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
    </div>
  );
}

function NotAvailable({ status, error }: { status: RazorpayStatus | null; error: string | null }) {
  const publicDemo = status?.ready === true && status.importsOpen === false;
  return (
    <div className="wizard page">
      <header className="wizard-head">
        <h1>Reconcile your Razorpay test account</h1>
      </header>
      <div className="card">
        {error ? (
          <p>Could not reach the server: {error}</p>
        ) : publicDemo ? (
          <p>
            This is the public demo, where importing is switched off. Run the free demo from the
            home page instead.
          </p>
        ) : (
          <>
            <h2 className="card-title">Switch on your test account</h2>
            <p className="muted">
              Set these in <code>.env</code>, then restart the server:
            </p>
            <ol className="how-to">
              <li>
                <code>RAZORPAY_SOURCE=testmode</code>
              </li>
              <li>
                <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code>: your{' '}
                <code>rzp_test_</code> keys (live keys are refused)
              </li>
              <li>
                <code>DEMO_MODE=false</code>
              </li>
              <li>
                Optionally <code>ADMIN_TOKEN</code>, a password of 16 or more characters, before you
                put it on the internet
              </li>
            </ol>
          </>
        )}
        <div className="actions">
          <a className="button" href="#/">
            Back to the home page
          </a>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  state,
  summary,
  children,
}: {
  n: number;
  title: string;
  state: 'wait' | 'now' | 'done';
  summary: string | null;
  children: ReactNode;
}) {
  return (
    <section className={`wstep ${state}`}>
      <span className="wnum" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={15} /> : n}
      </span>
      <div className="wbody">
        <h2>
          {title}
          {summary ? <span className="wsum"> · {summary}</span> : null}
        </h2>
        {state === 'wait' ? <p className="muted">Waiting for the step above.</p> : children}
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
