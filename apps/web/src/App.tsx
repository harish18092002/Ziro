import { useEffect, useState } from 'react';
import type { AgentStatus, RazorpayStatus } from './api';
import { get } from './api';
import { Logo } from './Brand';
import { agentBanner, dataChip, parseHash, replayNote } from './format';
import { Home } from './Home';
import { type ThemeMode, useHash, useLoad, useTheme } from './hooks';
import { Icon, type IconName } from './Icons';
import { LoginGate } from './Login';
import { NewRun } from './NewRun';
import { RunPage } from './RunPage';
import { Banner } from './ui';

const THEME_ICON: Record<ThemeMode, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_WORDS: Record<ThemeMode, string> = {
  system: 'following your system',
  light: 'light',
  dark: 'dark',
};

export function App() {
  return (
    <LoginGate>
      <Shell />
    </LoginGate>
  );
}

function Shell() {
  const route = parseHash(useHash());
  const [theme, stepTheme] = useTheme();
  const razorpay = useLoad<RazorpayStatus>('/razorpay/status').data;
  const home = route.page === 'home';
  const canImport = razorpay?.ready === true && razorpay.importsOpen;
  return (
    <>
      <header className="shell-top">
        <div className="shell-in">
          <a href="#/" className="brand" aria-label="Ziro, home">
            <Logo />
            <span>
              Ziro
              <small>every paisa, accounted for</small>
            </span>
          </a>
          {home ? (
            <nav className="nav" aria-label="Sections">
              <a href="#how">How it works</a>
              <a href="#trust">Trust</a>
              <a href="#try">Try it</a>
            </nav>
          ) : null}
          <div className="shell-right">
            <span className="env-chip">
              <span className="live-dot" /> {dataChip(razorpay)}
            </span>
            <button
              className="icon-btn"
              onClick={stepTheme}
              aria-label={`Theme: ${THEME_WORDS[theme]}. Switch theme.`}
              title={`Theme: ${THEME_WORDS[theme]}`}
            >
              <span key={theme} className="theme-icon">
                <Icon name={THEME_ICON[theme]} size={18} />
              </span>
            </button>
            {canImport && route.page !== 'new' ? (
              <a className="button primary sm" href="#/new">
                New reconciliation
              </a>
            ) : home ? (
              <a className="button primary sm" href="#try">
                Try it
              </a>
            ) : (
              <a className="button sm" href="#/">
                <Icon name="home" size={15} /> Home
              </a>
            )}
          </div>
        </div>
      </header>
      <AgentBanner />
      <main className={home ? 'bleed' : ''}>
        {route.page === 'home' ? (
          <Home razorpay={razorpay} />
        ) : route.page === 'new' ? (
          <NewRun />
        ) : (
          <RunPage route={route} />
        )}
      </main>
    </>
  );
}

/** Says so, on every page, while the agent cannot work as configured, or is replaying a record. */
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
  const replay = replayNote(status);
  if (text === null && replay === null) return null;
  return (
    <div className="banners">
      {text === null ? null : <Banner tone="warn">{text}</Banner>}
      {replay === null ? null : <Banner tone="info">{replay}</Banner>}
    </div>
  );
}
