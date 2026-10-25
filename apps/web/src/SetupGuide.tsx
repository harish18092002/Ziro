import { type ReactNode } from 'react';
import type { RazorpayStatus } from './api';
import { CopyBlock } from './CopyBlock';
import { Icon } from './Icons';

const ENV_LINES = [
  'RAZORPAY_SOURCE=testmode',
  'RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX',
  'RAZORPAY_KEY_SECRET=your-key-secret',
  'DEMO_MODE=false',
].join('\n');

function Steps({ children }: { children: ReactNode }) {
  return <ol className="guide-steps">{children}</ol>;
}

/**
 * Shown instead of the test-account workspace when it cannot run yet, and says exactly what is in the way:
 * the public demo (nothing to do), DEMO_MODE (one line), or no keys (the whole set-up, step by step).
 */
export function SetupGuide({ status }: { status: RazorpayStatus | null }) {
  const publicDemo = status !== null && !status.importsOpen && status.source !== 'testmode';
  const demoModeOn = status?.ready === true && !status.importsOpen;

  if (publicDemo) {
    return (
      <div className="card guide">
        <h2 className="card-title">Not available on the public demo</h2>
        <p>
          This site runs on generated data so anyone can try it safely. To reconcile your own
          Razorpay test account, run Ziro on your own computer. The demo is on the home page.
        </p>
        <div className="actions">
          <a className="button primary" href="#/">
            Back to the demo
          </a>
        </div>
      </div>
    );
  }

  if (demoModeOn) {
    return (
      <div className="card guide">
        <h2 className="card-title">One setting is in the way</h2>
        <p>
          Your Razorpay keys are connected ({status.keyId}), but <code>DEMO_MODE=true</code>{' '}
          switches off importing and refunds, the way the public demo does. Change it, restart and
          reload.
        </p>
        <Steps>
          <li>
            In the <code>.env</code> file in the project folder, change <code>DEMO_MODE=true</code>{' '}
            to <code>DEMO_MODE=false</code>.
          </li>
          <li>
            Stop the server (<kbd>Ctrl</kbd> + <kbd>C</kbd>) and start it again with{' '}
            <code>npm run dev</code>.
          </li>
          <li>Reload this page.</li>
        </Steps>
      </div>
    );
  }

  return (
    <div className="card guide">
      <h2 className="card-title">Connect your Razorpay test account</h2>
      <p>
        Ziro reads your own Razorpay <b>test</b> account: no real money, no real customers. It needs
        a pair of test keys. This takes about two minutes.
      </p>
      <Steps>
        <li>
          <b>Switch your Razorpay Dashboard to Test mode.</b> Sign in at{' '}
          <a href="https://dashboard.razorpay.com/" target="_blank" rel="noreferrer noopener">
            dashboard.razorpay.com
          </a>{' '}
          and select <b>Test</b> mode.
        </li>
        <li>
          <b>Generate a key.</b> Go to <b>Account &amp; Settings → API Keys → Generate Key</b>. Copy
          the Key Id (it starts with <code>rzp_test_</code>) and the Key Secret. Razorpay shows the
          secret once, so save it now.
        </li>
        <li>
          <b>Put them in the .env file</b> in the project folder. Replace the two example values:
          <CopyBlock text={ENV_LINES} label="the four .env lines" />
        </li>
        <li>
          <b>Restart.</b> Stop the server (<kbd>Ctrl</kbd> + <kbd>C</kbd>), run{' '}
          <code>npm run dev</code> again, then reload this page.
        </li>
      </Steps>
      <p className="muted note">
        <Icon name="shield" size={14} />
        <span>
          Live keys (<code>rzp_live_</code>) are refused: Ziro works with test mode only. Your
          secret stays in <code>.env</code> on this machine and is never shown here.
        </span>
      </p>
      <details className="fold">
        <summary>Sharing this server with other people?</summary>
        <p>
          Anyone who can open this page can create payments and refunds in your test account. On
          your own computer that is only you. If others can reach it, add a password: set{' '}
          <code>ADMIN_TOKEN</code> in <code>.env</code> to a phrase of 16 or more characters and
          restart. Ziro then asks for it once.
        </p>
      </details>
    </div>
  );
}
