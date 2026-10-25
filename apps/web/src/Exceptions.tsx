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
import { Meter } from './Charts';
import { inr, linkTo, sentence, words } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Banner } from './ui';

const FILTERS = [
  ['all', 'All'],
  ['waiting', 'Waiting for a person'],
  ['refused', 'Refused by the checker'],
  ['unexamined', 'Not yet investigated'],
  ['degraded', 'Handed to a person by the system'],
  ['resolved', 'Resolved'],
] as const;
type Filter = (typeof FILTERS)[number][0];

const AUTHOR: Record<string, { icon: IconName; text: string }> = {
  scripted: { icon: 'code', text: 'Scripted baseline (not a language model)' },
  planted: { icon: 'flag', text: 'PLANTED by the demo to show the checker (not model output)' },
  model: { icon: 'bot', text: 'Language model' },
  harness: {
    icon: 'alert',
    text: 'Nobody: the system handed this to a person without a conclusion',
  },
};

const RECORD_ICON: Record<string, IconName> = {
  ledger_entry: 'book',
  rzp_payment: 'rupee',
  rzp_refund: 'refresh',
  rzp_settlement: 'layers',
  bank_line: 'bank',
};

export function ExceptionsTab({
  runId,
  selected,
  readOnly,
}: {
  runId: string;
  selected: string | null;
  /** A featured replay or an archived run: nothing here can be approved or rejected. */
  readOnly: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const list = useLoad<ExceptionList>(`/runs/${runId}/exceptions?filter=${filter}&limit=200`);

  return (
    <div className="exc-layout">
      <section className="card exc-list">
        <div className="chips" role="group" aria-label="Filter exceptions">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              className={f === filter ? 'chip on' : 'chip'}
              aria-pressed={f === filter}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        {list.error ? (
          <Banner tone="bad" role="alert">
            {list.error}
          </Banner>
        ) : null}
        {/* Reloading keeps the previous rows on screen, faded, so the list never jumps. */}
        <div className={`table-wrap ${list.data === null ? 'loading' : ''}`}>
          <table className="data rows">
            <thead>
              <tr>
                <th>Record</th>
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
                    <span className="row-sub">
                      {sentence(e.reasonCode)}
                      {e.ageDays === null ? '' : ` · ${e.ageDays} days old`}
                    </span>
                  </td>
                  <td className="n">{inr(e.amountAtStakePaise)}</td>
                  <td>
                    <Status e={e} />
                  </td>
                  <td>
                    {e.proposal?.degradedLabel ? (
                      <span className="pill wait" title={e.proposal.degradedLabel}>
                        <Icon name="alert" size={13} /> agent stopped
                      </span>
                    ) : e.proposal ? (
                      <Verdict v={e.proposal.verifier} />
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data === null && !list.error
          ? [0, 1, 2, 3, 4].map((n) => <div key={n} className="skel row-skel" />)
          : null}
        {list.data && list.data.items.length === 0 ? (
          <p className="empty">
            <Icon name="check" size={18} /> Nothing here.
          </p>
        ) : null}
        {list.data ? <p className="muted count-line">{list.data.total} in this view</p> : null}
      </section>
      <aside className="exc-detail">
        {selected ? (
          <Detail
            key={selected}
            runId={runId}
            id={selected}
            readOnly={readOnly}
            onChanged={list.reload}
          />
        ) : (
          <div className="card empty-detail">
            <span className="ico">
              <Icon name="search" size={22} />
            </span>
            <h3>Pick an exception</h3>
            <p>See the records involved, the agent’s reasoning and the checker’s verdict.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Status({ e }: { e: ExceptionRow }) {
  if (e.status === 'resolved')
    return (
      <span className="pill ok">
        <Icon name="check" size={13} /> resolved{e.review ? ` · ${e.review.decision}` : ''}
      </span>
    );
  if (e.status === 'proposed')
    return (
      <span className="pill wait">
        <Icon name="clock" size={13} /> waiting for a person
      </span>
    );
  if (e.proposal?.verifier === 'rejected')
    return (
      <span className="pill bad">
        <Icon name="x" size={13} /> proposal refused
      </span>
    );
  if (e.listedForAPerson)
    return (
      <span className="pill">
        <Icon name="user" size={13} /> for a person
      </span>
    );
  return <span className="pill">{e.status}</span>;
}

function Verdict({ v }: { v: string }) {
  if (v === 'passed')
    return (
      <span className="pill ok">
        <Icon name="shield" size={13} /> verified
      </span>
    );
  if (v === 'rejected')
    return (
      <span className="pill bad">
        <Icon name="x" size={13} /> REJECTED
      </span>
    );
  if (v === 'not_applicable') return <span className="pill">no match claimed</span>;
  return <span className="pill">{v}</span>;
}

function Detail({
  runId,
  id,
  readOnly,
  onChanged,
}: {
  runId: string;
  id: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const d = useLoad<ExceptionDetail>(`/exceptions/${id}`);
  if (d.error)
    return (
      <Banner tone="bad" role="alert">
        {d.error}
      </Banner>
    );
  if (!d.data)
    return (
      <div className="card detail">
        <div className="skel" style={{ height: 28, width: '60%', marginBottom: 14 }} />
        <div className="skel" style={{ height: 80, marginBottom: 14 }} />
        <div className="skel" style={{ height: 160 }} />
      </div>
    );
  const { exception: e, subject, candidates, proposals } = d.data;
  const latest = proposals.at(-1);

  return (
    <div className="card detail slide-in">
      <header className="detail-head">
        <span className="kicker">{words(e.reasonCode)}</span>
        <h2>{subject?.key ?? 'Exception'}</h2>
        <div className="detail-meta">
          <span className="stake">{inr(e.amountAtStakePaise)}</span>
          <span className="muted">
            at stake{e.ageDays === null ? '' : ` · ${e.ageDays} days old`}
          </span>
        </div>
        {e.note ? <p className="free muted">{e.note}</p> : null}
      </header>

      <div className="callout">
        <Icon name="arrow" size={18} />
        <div>
          <b>Next step</b>
          <p className="free">{e.nextStep}</p>
        </div>
      </div>

      <h3 className="mini-title">Records involved</h3>
      <Records runId={runId} rows={[...(subject ? [subject] : []), ...candidates]} />

      {latest ? (
        <ProposalCard
          p={latest}
          decidable={
            !readOnly &&
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
        <p className="muted block">
          {e.listedForAPerson
            ? 'The rules left nothing for an agent to look at; this is listed for a person.'
            : 'The agent has not investigated this one.'}
        </p>
      )}
      {readOnly ? (
        <p className="muted block">
          <Icon name="lock" size={14} /> This run is read-only, so proposals cannot be approved or
          rejected here. Start your own run to review them.
        </p>
      ) : null}
    </div>
  );
}

function Records({ runId, rows }: { runId: string; rows: Described[] }) {
  return (
    <ul className="records">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="rec-ico">
            <Icon name={RECORD_ICON[r.type] ?? 'file'} size={16} />
          </span>
          <div className="rec-main">
            <a href={linkTo(runId, 'audit', r.id)} title="Open the audit timeline">
              {r.key}
            </a>
            <span className="muted free">
              {words(r.type)}
              {r.date ? ` · ${r.date}` : ''}
              {r.detail ? ` · ${r.detail}` : ''}
            </span>
          </div>
          <b className="rec-amt">{inr(r.amountPaise)}</b>
        </li>
      ))}
    </ul>
  );
}

function ProposalCard(props: { p: ProposalDetail; decidable: boolean; onDone: () => void }) {
  const { p } = props;
  const [reviewer, setReviewer] = useState('a visitor');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const author = AUTHOR[p.author] ?? { icon: 'bot' as const, text: p.author };

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
      <h3 className="mini-title">The agent’s proposal</h3>
      <p className="author">
        <Icon name={author.icon} size={16} /> {author.text}
      </p>
      {p.degradedLabel ? (
        <Banner tone="warn">
          <b>The agent did not reach a conclusion:</b> {p.degradedLabel}. This is the system handing
          the exception to a person, not a finding about the records.
        </Banner>
      ) : null}

      <div className="verdict-row">
        <span className="pill info">{words(p.verdict)}</span>
        <span className="pill">{words(p.reasonCode)}</span>
        <span className="pill">suggested: {words(p.suggestedAction)}</span>
      </div>
      <div className="confidence">
        <span>Confidence</span>
        <Meter value={p.confidence} label="Agent confidence" />
        <b>{Math.round(p.confidence * 100)}%</b>
      </div>
      <blockquote className="quote free">{p.explanation}</blockquote>

      <h3 className="mini-title">Evidence, step by step</h3>
      <ol className="evidence">
        {p.evidence.map((ev, i) => (
          <li key={i}>
            <span className="ev-n">{i + 1}</span>
            <div>
              <span className="free">{ev.keyFinding}</span>
              <div className="muted ev-src">
                from <code>{ev.tool}</code> <code>{JSON.stringify(ev.args)}</code>
              </div>
            </div>
          </li>
        ))}
        {p.evidence.length === 0 ? <li className="muted">No evidence was attached.</li> : null}
      </ol>
      {p.harnessFindings.length > 0 ? (
        <ul className="muted free findings-list">
          {p.harnessFindings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      ) : null}

      <h3 className="mini-title">Checker’s verdict</h3>
      <CheckerBlock p={p} />

      {p.draftJournalEntry ? (
        <>
          <h3 className="mini-title">Draft journal entry</h3>
          <p className="free">{p.draftJournalEntry.memo}</p>
          <div className="table-wrap">
            <table className="data">
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
          </div>
        </>
      ) : null}

      {p.review ? (
        <div className="decided" role="status">
          <span className="decided-ico">
            <Icon name={p.review.decision === 'approved' ? 'check' : 'x'} size={20} />
          </span>
          <div>
            <b>
              {p.review.decision} by {p.review.reviewer}
            </b>
            {p.review.note ? <p className="muted">{p.review.note}</p> : null}
          </div>
        </div>
      ) : props.decidable ? (
        <div className="decide">
          <h3 className="mini-title">Your decision</h3>
          <label>
            <span>Your name</span>
            <input
              aria-label="your name"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            <span>Note (required to reject)</span>
            <textarea
              aria-label="note"
              placeholder="Why you decided this"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <div className="decide-actions">
            <button className="primary" disabled={busy} onClick={() => void decide('approve')}>
              {busy ? <span className="spinner" /> : <Icon name="check" size={16} />} Approve
            </button>
            <button disabled={busy || note.trim() === ''} onClick={() => void decide('reject')}>
              <Icon name="x" size={16} /> Reject
            </button>
          </div>
          {problem ? (
            <Banner tone="bad" role="alert">
              {problem}
            </Banner>
          ) : null}
        </div>
      ) : p.verifier.status === 'rejected' ? (
        <p className="muted block">
          The checker refused this proposal, so it cannot be approved. The exception stays open.
        </p>
      ) : null}
    </>
  );
}

function CheckerBlock({ p }: { p: ProposalDetail }) {
  const status = p.verifier.status;
  const ok = status === 'passed';
  const bad = status === 'rejected';
  return (
    <div className={`checker ${ok ? 'ok' : bad ? 'bad' : ''}`}>
      <span className="checker-ico">
        <Icon name={ok ? 'shield' : bad ? 'x' : 'info'} size={22} />
      </span>
      <div>
        <b>
          {ok
            ? 'Verified'
            : bad
              ? 'Refused'
              : status === 'not_applicable'
                ? 'No match claimed'
                : status}
        </b>
        {p.verifier.findings.length > 0 ? (
          <ul className="findings">
            {p.verifier.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {ok
              ? 'Every id, amount and date was re-computed from the records and agrees.'
              : 'There was nothing for the checker to verify.'}
          </p>
        )}
      </div>
    </div>
  );
}
