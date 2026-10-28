import { useState } from 'react';
import type { Described, ExceptionList, Timeline } from './api';
import { inr, linkTo, words } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Banner } from './ui';

// Who did a thing is shown by an icon AND a word, never by colour alone.
// The colour follows the flow's actors: code (rule, verifier, system), AI (agent), a person.
const ACTOR: Record<string, { icon: IconName; label: string; lane: 'code' | 'ai' | 'you' }> = {
  rule: { icon: 'code', label: 'Rule', lane: 'code' },
  agent: { icon: 'bot', label: 'Agent', lane: 'ai' },
  verifier: { icon: 'shield', label: 'Verifier', lane: 'code' },
  human: { icon: 'user', label: 'Person', lane: 'you' },
  system: { icon: 'gear', label: 'System', lane: 'code' },
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
  // A few records worth following, so the page is never a blank search box: the largest exceptions' subjects.
  const picks = useLoad<ExceptionList>(`/runs/${runId}/exceptions?filter=all&limit=6`).data;

  return (
    <div className="exc-layout">
      <section className="card exc-list">
        <h2 className="card-title">Follow any record</h2>
        <p className="card-sub">
          Every import, rule match, proposal, verdict and decision that touched it, in order. The
          trail is append-only.
        </p>
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
        {!searching && picks && picks.items.length > 0 ? (
          <div className="picks">
            <span className="kicker">Or start with a case</span>
            <ul className="records found">
              {picks.items
                .filter((e) => e.subject !== null)
                .map((e) => (
                  <li key={e.id} className={e.subject?.id === selected ? 'sel' : ''}>
                    <span className="rec-ico">
                      <Icon name={RECORD_ICON[e.subject?.type ?? ''] ?? 'file'} size={16} />
                    </span>
                    <div className="rec-main">
                      <a href={linkTo(runId, 'audit', e.subject?.id)}>{e.subject?.key}</a>
                      <span className="muted">{words(e.reasonCode)}</span>
                    </div>
                    <b className="rec-amt">{inr(e.amountAtStakePaise)}</b>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        {!searching && !picks ? <p className="muted block">Type at least two characters.</p> : null}
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
            <p>
              Its story appears here, from import to approval: who acted (code, AI or a person) and
              why.
            </p>
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
                const actor = ACTOR[t.actor] ?? {
                  icon: 'gear' as const,
                  label: t.actor,
                  lane: 'code' as const,
                };
                return (
                  <li
                    key={t.id}
                    className={`lane-${actor.lane}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}
                  >
                    <span className="tl-dot">
                      <Icon name={actor.icon} size={15} />
                    </span>
                    <div className="tl-body">
                      <div className="tl-top">
                        <b>{t.action}</b>
                        <span className="tl-actor">{actor.label}</span>
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
