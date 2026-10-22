import { useState } from 'react';
import {
  ApiError,
  type Described,
  type ExceptionDetail,
  type ExceptionList,
  type ExceptionRow,
  type ProposalDetail,
  post,
} from './api';
import { inr, linkTo, words } from './format';
import { useLoad } from './hooks';

const FILTERS = [
  ['all', 'All'],
  ['waiting', 'Waiting for a person'],
  ['refused', 'Refused by the checker'],
  ['unexamined', 'Not yet investigated'],
  ['resolved', 'Resolved'],
] as const;
type Filter = (typeof FILTERS)[number][0];

const AUTHOR: Record<string, string> = {
  scripted: 'scripted baseline (not a language model)',
  planted: 'PLANTED by the demo to show the checker (not model output)',
  model: 'language model',
};

export function ExceptionsTab({ runId, selected }: { runId: string; selected: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const list = useLoad<ExceptionList>(`/runs/${runId}/exceptions?filter=${filter}&limit=200`);

  return (
    <div className="split">
      <section>
        <div className="chips">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              className={f === filter ? 'chip on' : 'chip'}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        {list.error ? <p className="bad">{list.error}</p> : null}
        <table className="rows">
          <thead>
            <tr>
              <th>Record</th>
              <th>Reason</th>
              <th className="n">At stake</th>
              <th>Status</th>
              <th>Checker</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((e) => (
              <tr key={e.id} className={e.id === selected ? 'sel' : ''}>
                <td>
                  <a href={linkTo(runId, 'exceptions', e.id)}>
                    {e.subject?.key ?? e.id.slice(0, 8)}
                  </a>
                </td>
                <td>{words(e.reasonCode)}</td>
                <td className="n">{inr(e.amountAtStakePaise)}</td>
                <td>
                  <Status e={e} />
                </td>
                <td>
                  {e.proposal ? (
                    <Verdict v={e.proposal.verifier} />
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && list.data.items.length === 0 ? <p className="muted">Nothing here.</p> : null}
        {list.data ? <p className="muted">{list.data.total} in this view</p> : null}
      </section>
      <aside>
        {selected ? (
          <Detail key={selected} runId={runId} id={selected} onChanged={list.reload} />
        ) : (
          <p className="muted">
            Pick an exception to see the records, the agent's reasoning and the checker's verdict.
          </p>
        )}
      </aside>
    </div>
  );
}

function Status({ e }: { e: ExceptionRow }) {
  if (e.status === 'resolved')
    return <span className="pill ok">resolved{e.review ? ` · ${e.review.decision}` : ''}</span>;
  if (e.status === 'proposed') return <span className="pill wait">waiting for a person</span>;
  if (e.proposal?.verifier === 'rejected')
    return <span className="pill bad">proposal refused</span>;
  if (e.listedForAPerson) return <span className="pill">for a person</span>;
  return <span className="pill">{e.status}</span>;
}

function Verdict({ v }: { v: string }) {
  if (v === 'passed') return <span className="pill ok">verified</span>;
  if (v === 'rejected') return <span className="pill bad">REJECTED</span>;
  if (v === 'not_applicable') return <span className="pill">no match claimed</span>;
  return <span className="pill">{v}</span>;
}

function Detail({ runId, id, onChanged }: { runId: string; id: string; onChanged: () => void }) {
  const d = useLoad<ExceptionDetail>(`/exceptions/${id}`);
  if (d.error) return <p className="bad">{d.error}</p>;
  if (!d.data) return <p className="muted">Loading…</p>;
  const { exception: e, subject, candidates, proposals } = d.data;
  const latest = proposals.at(-1);

  return (
    <div className="detail">
      <h2>{subject?.key ?? 'Exception'}</h2>
      <p>
        <b>{words(e.reasonCode)}</b> · {inr(e.amountAtStakePaise)} at stake
        {e.note ? (
          <>
            {' '}
            · <span className="free">{e.note}</span>
          </>
        ) : null}
      </p>

      <h3>Records involved</h3>
      <Records runId={runId} rows={[...(subject ? [subject] : []), ...candidates]} />

      {latest ? (
        <ProposalCard
          runId={runId}
          p={latest}
          decidable={
            e.status === 'proposed' &&
            latest.review === null &&
            latest.verifier.status !== 'rejected'
          }
          onDone={() => {
            d.reload();
            onChanged();
          }}
        />
      ) : (
        <p className="muted">
          {e.listedForAPerson
            ? 'The rules left nothing for an agent to look at; this is listed for a person.'
            : 'The agent has not investigated this one.'}
        </p>
      )}
    </div>
  );
}

function Records({ runId, rows }: { runId: string; rows: Described[] }) {
  return (
    <table className="mini">
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="muted">{words(r.type)}</td>
            <td>
              <a href={linkTo(runId, 'audit', r.id)} title="audit timeline">
                {r.key}
              </a>
            </td>
            <td className="n">{inr(r.amountPaise)}</td>
            <td className="muted free">
              {r.date ?? ''} {r.detail}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProposalCard(props: {
  runId: string;
  p: ProposalDetail;
  decidable: boolean;
  onDone: () => void;
}) {
  const { p } = props;
  const [reviewer, setReviewer] = useState('a visitor');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const decide = async (what: 'approve' | 'reject') => {
    setBusy(true);
    setProblem(null);
    try {
      await post(`/proposals/${p.id}/${what}`, {
        reviewer: reviewer.trim() || 'a visitor',
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      props.onDone();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>The agent's proposal</h3>
      <p className="muted">By: {AUTHOR[p.author] ?? p.author}</p>
      <p>
        <b>{words(p.verdict)}</b> · {words(p.reasonCode)} · confidence{' '}
        {Math.round(p.confidence * 100)}% · suggested: {words(p.suggestedAction)}
      </p>
      <blockquote className="free">{p.explanation}</blockquote>

      <h3>Evidence, step by step</h3>
      <ol className="evidence">
        {p.evidence.map((ev, i) => (
          <li key={i}>
            <span className="free">{ev.keyFinding}</span>
            <div className="muted">
              from <code>{ev.tool}</code> <code>{JSON.stringify(ev.args)}</code>
            </div>
          </li>
        ))}
        {p.evidence.length === 0 ? <li className="muted">No evidence was attached.</li> : null}
      </ol>
      {p.harnessFindings.length > 0 ? (
        <ul className="muted free">
          {p.harnessFindings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      ) : null}

      <h3>Checker's verdict</h3>
      <p>
        <Verdict v={p.verifier.status} />
      </p>
      {p.verifier.findings.length > 0 ? (
        <ul className="findings">
          {p.verifier.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Every id, amount and date was re-computed from the records and agrees.
        </p>
      )}

      {p.draftJournalEntry ? (
        <>
          <h3>Draft journal entry</h3>
          <p className="free">{p.draftJournalEntry.memo}</p>
          <table className="mini">
            <tbody>
              {p.draftJournalEntry.lines.map((l, i) => (
                <tr key={i}>
                  <td>{words(l.account)}</td>
                  <td className="n">{l.debit === '0' ? '' : `Dr ${inr(l.debit)}`}</td>
                  <td className="n">{l.credit === '0' ? '' : `Cr ${inr(l.credit)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {p.review ? (
        <p className="pill ok">
          {p.review.decision} by {p.review.reviewer}
          {p.review.note ? `: ${p.review.note}` : ''}
        </p>
      ) : props.decidable ? (
        <div className="decide">
          <input
            aria-label="your name"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            maxLength={100}
          />
          <input
            aria-label="note"
            placeholder="note (required to reject)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
          <button className="primary" disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </button>
          <button disabled={busy || note.trim() === ''} onClick={() => void decide('reject')}>
            Reject
          </button>
          {problem ? <p className="bad">{problem}</p> : null}
        </div>
      ) : p.verifier.status === 'rejected' ? (
        <p className="muted">
          The checker refused this proposal, so it cannot be approved. The exception stays open.
        </p>
      ) : null}
    </>
  );
}
