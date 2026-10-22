import { useState } from 'react';
import type { Described, Timeline } from './api';
import { inr, linkTo, words } from './format';
import { useLoad } from './hooks';

/** Find a record by key, then read everything that ever touched it, in order. */
export function AuditTab({ runId, selected }: { runId: string; selected: string | null }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const found = useLoad<Described[]>(
    query.trim().length >= 2
      ? `/runs/${runId}/records?q=${encodeURIComponent(query.trim())}`
      : null,
  );
  const timeline = useLoad<Timeline>(selected ? `/records/${selected}/audit` : null);

  return (
    <div className="split">
      <section>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text);
          }}
        >
          <input
            aria-label="find a record"
            placeholder="order reference, pay_…, setl_…, UTR or statement row"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary">Find</button>
        </form>
        {found.error ? <p className="bad">{found.error}</p> : null}
        {query.trim().length < 2 ? <p className="muted">Type at least two characters.</p> : null}
        <table className="rows">
          <tbody>
            {(query.trim().length >= 2 ? (found.data ?? []) : []).map((r) => (
              <tr key={r.id} className={r.id === selected ? 'sel' : ''}>
                <td className="muted">{words(r.type)}</td>
                <td>
                  <a href={linkTo(runId, 'audit', r.id)}>{r.key}</a>
                </td>
                <td className="n">{inr(r.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside>
        {!selected ? <p className="muted">Pick a record to see its timeline.</p> : null}
        {timeline.error ? <p className="bad">{timeline.error}</p> : null}
        {timeline.data ? (
          <>
            <h2>{timeline.data.record.key}</h2>
            <p className="muted">
              {words(timeline.data.record.type)} · {inr(timeline.data.record.amountPaise)} ·{' '}
              {timeline.data.record.date}
            </p>
            <ol className="timeline">
              {timeline.data.timeline.map((t) => (
                <li key={t.id}>
                  <div>
                    <b>{t.action}</b> <span className="pill">{t.actor}</span>
                  </div>
                  <div className="muted">{new Date(t.at).toLocaleString()}</div>
                  {t.reason ? <div className="free">{t.reason}</div> : null}
                </li>
              ))}
            </ol>
            {timeline.data.truncated ? (
              <p className="muted">Showing the first part of a longer timeline.</p>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
