import { type FormEvent, type ReactNode, useState } from 'react';
import { ApiError, type AuthStatus, post } from './api';
import { Logo } from './Brand';
import { useLoad } from './hooks';
import { Icon } from './Icons';
import { Banner } from './ui';

/**
 * Shows the app, or, on a private deployment that has an admin token, a sign-in first. With no token set
 * (a laptop, the public demo) it shows the app at once. If the server cannot be reached it shows the app
 * too, which then explains its own errors.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const status = useLoad<AuthStatus>('/auth/status');
  const [signedIn, setSignedIn] = useState(false);
  if (status.data === null && status.error === null) return <div className="login-wait" />;
  if (status.data?.required === true && !status.data.authenticated && !signedIn) {
    return <LoginForm onDone={() => setSignedIn(true)} />;
  }
  return <>{children}</>;
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await post('/auth/login', { token });
      onDone();
    } catch (e) {
      setProblem(
        e instanceof ApiError && e.status === 401
          ? 'That is not the admin token.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setBusy(false);
    }
  };

  return (
    <main className="login page">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <Logo size={40} />
        <h1>Sign in to Ziro</h1>
        <p className="muted">This deployment is private. Enter the admin token to continue.</p>
        <label>
          <span className="sr-only">Admin token</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
        </label>
        {problem ? (
          <Banner tone="bad" role="alert">
            {problem}
          </Banner>
        ) : null}
        <button className="primary lg" disabled={busy || token === ''}>
          {busy ? <span className="spinner" /> : <Icon name="lock" size={16} />} Sign in
        </button>
      </form>
    </main>
  );
}
