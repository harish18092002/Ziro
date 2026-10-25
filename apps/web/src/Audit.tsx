import { useState } from 'react';
import type { Described, Timeline } from './api';
import { inr, linkTo, words } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Banner } from './ui';

// Who did a thing is shown by an icon AND a word, never by colour alone.
const ACTOR: Record<string, { icon: IconName; label: string }> = {
  rule: { icon: 'code', label: 'Rule' },
  agent: { icon: 'bot', label: 'Agent' },
  verifier: { icon: 'shield', label: 'Verifier' },
  human: { icon: 'user', label: 'Person' },
  system: { icon: 'gear', label: 'System' },
};

const RECORD_ICON: Record<string, IconName> = {
  ledger_entry: 'book',
  rzp_payment: 'rupee',
  rzp_refund: 'refresh',
  rzp_settlement: 'layers',
  bank_line: 'bank',
};

/** Find a record by key, then read everything that ever touched it, in order. */
export function AuditTab({ runId, selected }: { runId: string; selected: string | null }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= 2;
  const found = useLoad<Described[]>(
    searching ? `/runs/${runId}/records?q=${encodeURIComponent(query.trim())}` : null,
  );
  const timeline = useLoad<Timeline>(selected ? `/records/${selected}/audit` : null);

  return (
    <div className="exc-layout">
      <section className="card exc-list">
        <h2 className="card-title">Find a record</h2>
        <p className="card-sub">An order, payment, payout, UTR or statement row.</p>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text);
          }}
        >
          <span className="search-ico">
            <Icon name="search" size={17} />
          </span>
          <input
            aria-label="find a record"
            placeholder="ORD-100002, pay_…, setl_…, UTR or statement row"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary">Find</button>
        </form>
        {found.error ? (
          <Banner tone="bad" role="alert">
            {found.error}
          </Banner>
        ) : null}
        {!searching ? <p className="muted block">Type at least two characters.</p> : null}
        {searching && found.data && found.data.length === 0 ? (
          <p className="empty">
            <Icon name="search" size={18} /> Nothing found for “{query.trim()}”.
          </p>
        ) : null}
        <ul className="records found">
          {(searching ? (found.data ?? []) : []).map((r) => (
            <li key={r.id} className={r.id === selected ? 'sel' : ''}>
              <span className="rec-ico">
                <Icon name={RECORD_ICON[r.type] ?? 'file'} size={16} />
              </span>
              <div className="rec-main">
                <a href={linkTo(runId, 'audit', r.id)}>{r.key}</a>
                <span className="muted">{words(r.type)}</span>
              </div>
              <b className="rec-amt">{inr(r.amountPaise)}</b>
            </li>
          ))}
        </ul>
      </section>

      <aside className="exc-detail">
        {!selected ? (
          <div className="card empty-detail">
            <span className="ico">
              <Icon name="list" size={22} />
            </span>
            <h3>Pick a record</h3>
            <p>Its whole story appears here: imported, matched, proposed, verified, approved.</p>
          </div>
        ) : null}
        {timeline.error ? (
          <Banner tone="bad" role="alert">
            {timeline.error}
          </Banner>
        ) : null}
        {timeline.data ? (
          <div className="card detail slide-in" key={timeline.data.record.id}>
            <header className="detail-head">
              <span className="kicker">{words(timeline.data.record.type)}</span>
              <h2>{timeline.data.record.key}</h2>
              <div className="detail-meta">
                <span className="stake">{inr(timeline.data.record.amountPaise)}</span>
                <span className="muted">{timeline.data.record.date}</span>
              </div>
            </header>
            <ol className="timeline">
              {timeline.data.timeline.map((t, i) => {
                const actor = ACTOR[t.actor] ?? { icon: 'gear' as const, label: t.actor };
                return (
                  <li key={t.id} style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}>
                    <span className="tl-dot">
                      <Icon name={actor.icon} size={15} />
                    </span>
                    <div className="tl-body">
                      <div className="tl-top">
                        <b>{t.action}</b>
                        <span className="pill">{actor.label}</span>
                      </div>
                      <div className="muted tl-time">{new Date(t.at).toLocaleString()}</div>
                      {t.reason ? <div className="free tl-reason">{t.reason}</div> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            {timeline.data.truncated ? (
              <p className="muted block">Showing the first part of a longer timeline.</p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
