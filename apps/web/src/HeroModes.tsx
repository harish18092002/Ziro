import { useEffect, useState } from 'react';
import type { RazorpayStatus } from './api';
import { maskKeyId } from './format';
import { useLoop, usePrefersReducedMotion } from './hooks';
import { Icon, type IconName } from './Icons';

// The hero's picture: the two ways into Ziro as two short lifecycles, one at a time. "Razorpay test mode" is the
// real integration (Checkout on /pay.html, refunds from the payments table, a read-only import, then the same
// reconciliation); "Sample demo" is generated data. It is an illustration of the steps, labelled as such: nothing
// here creates a payment, a refund or a run, and the account status line is the server's own answer.

type Mode = 'testmode' | 'demo';

interface Step {
  icon: IconName;
  title: string;
  note: string;
}

const STEPS: Record<Mode, Step[]> = {
  testmode: [
    { icon: 'rupee', title: 'Test payment', note: 'Razorpay Checkout, test card or UPI' },
    { icon: 'check', title: 'Captured', note: 'Razorpay records the fee and GST' },
    { icon: 'refresh', title: 'Refund', note: 'optional · full or part, from the table' },
    { icon: 'download', title: 'Import', note: 'payments and refunds, read-only' },
    { icon: 'code', title: 'Reconcile', note: 'against your ledger: rules, then AI' },
    { icon: 'user', title: 'Review', note: 'exceptions, approve, audit trail' },
  ],
  demo: [
    { icon: 'book', title: '50 orders', note: 'generated, with planted anomalies' },
    { icon: 'code', title: 'Rules', note: 'prove the bulk to the paisa' },
    { icon: 'bot', title: 'Agent', note: 'a scripted stand-in, no model' },
    { icon: 'shield', title: 'Checker', note: 'refuses 2 planted wrong proposals' },
    { icon: 'user', title: 'You', note: 'approve or reject' },
    { icon: 'file', title: 'Books', note: 'vouchers, leakage, audit trail' },
  ],
};

const STEP_MS = 1_500;

export type AccountState = 'loading' | 'ready' | 'setup' | 'demo-mode' | 'public';

/** What the test-account path can honestly offer on this server. */
export function accountState(razorpay: RazorpayStatus | null): AccountState {
  if (razorpay === null) return 'loading';
  if (razorpay.ready && razorpay.importsOpen) return 'ready';
  if (razorpay.ready) return 'demo-mode';
  return razorpay.importsOpen ? 'setup' : 'public';
}

function accountLine(state: AccountState, keyId: string | null): string {
  switch (state) {
    case 'ready':
      return `Connected to ${keyId ? maskKeyId(keyId) : 'a test key'}. Test mode: no real money moves.`;
    case 'demo-mode':
      return 'Test keys are set, but this server runs as a public demo, so imports are off.';
    case 'setup':
      return 'No test keys on this server yet; the test-account page shows where to copy them.';
    case 'public':
      return 'On the public demo this path is off: run Ziro locally with your own test keys.';
    default:
      return 'Checking this server…';
  }
}

export function HeroModes({
  razorpay,
  onRunDemo,
  busy,
}: {
  razorpay: RazorpayStatus | null;
  onRunDemo: () => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<Mode>('testmode');
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(true);
  const reduced = usePrefersReducedMotion();
  const [ref, onScreen] = useLoop<HTMLDivElement>();
  const running = playing && onScreen && !reduced;
  const steps = STEPS[mode];
  const state = accountState(razorpay);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setAt((n) => (n + 1) % (steps.length + 1)), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [running, at, steps.length]);

  const shown = reduced ? steps.length : at;
  const choose = (m: Mode) => {
    setMode(m);
    setAt(0);
  };

  return (
    <div ref={ref} className="modes" data-loops={onScreen ? 'on' : 'off'}>
      <div className="modes-head">
        <div className="segmented" role="tablist" aria-label="Two ways into Ziro">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'testmode'}
            className={mode === 'testmode' ? 'on' : ''}
            onClick={() => choose('testmode')}
          >
            <Icon name="shield" size={13} /> Razorpay test mode
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'demo'}
            className={mode === 'demo' ? 'on' : ''}
            onClick={() => choose('demo')}
          >
            <Icon name="sparkle" size={13} /> Sample demo
          </button>
        </div>
        {reduced ? null : (
          <button
            type="button"
            className="ghost sm"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? 'Pause the steps' : 'Play the steps'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={13} />
          </button>
        )}
      </div>

      <p className="modes-tag">
        {mode === 'testmode' ? (
          <>
            <b>Real Razorpay test data.</b> Your own test account, through Razorpay’s API.
          </>
        ) : (
          <>
            <b>Synthetic data.</b> Generated orders with known answers, in about two seconds.
          </>
        )}
      </p>

      <ol
        className="lifecycle"
        aria-label={mode === 'testmode' ? 'Test-mode workflow' : 'Sample demo workflow'}
        key={mode}
      >
        {steps.map((s, i) => (
          <li key={s.title} className={i < shown ? 'done' : i === shown ? 'now' : ''}>
            <span className="lc-dot">
              <Icon name={s.icon} size={15} />
            </span>
            <span className="lc-text">
              <b>{s.title}</b>
              <span>{s.note}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="modes-foot">
        {mode === 'testmode' ? (
          <>
            <p className={`acct ${state}`}>
              <span className="acct-dot" aria-hidden="true" />
              {accountLine(state, razorpay?.keyId ?? null)}
            </p>
            {state === 'public' || state === 'loading' ? null : (
              <a className="button primary sm" href="#/test">
                {state === 'ready' ? 'Open the test account' : 'See how to set it up'}{' '}
                <Icon name="arrow" size={14} />
              </a>
            )}
          </>
        ) : (
          <>
            <p className="acct">Scripted agent by default; no AI request is made.</p>
            <button className="primary sm" onClick={onRunDemo} disabled={busy}>
              {busy ? <span className="spinner" /> : null} Run the demo{' '}
              <Icon name="arrow" size={14} />
            </button>
          </>
        )}
      </div>
      <p className="modes-fine">
        {mode === 'testmode'
          ? 'An illustration of the steps: nothing is created until you pay on the test page. Test payments are rarely settled to a bank, so the bank statement step is optional.'
          : 'An illustration of the steps; the run itself reports only what the server did.'}
      </p>
    </div>
  );
}
