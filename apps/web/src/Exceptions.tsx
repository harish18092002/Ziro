import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import {
  ApiError,
  type Described,
  type ExceptionDetail,
  type ExceptionList,
  type ExceptionRow,
  type Overview,
  type ProposalDetail,
  post,
} from './api';
import { Meter } from './Charts';
import { inr, type ListQuery, linkTo, sentence, words } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { reasonMeaning } from './reasons';
import { type MoneyState, STATE } from './states';
import { Banner } from './ui';

// Exceptions: a triage list on the left (a status view, a reason, largest at stake first, 25 to a page) and on the
// right the case file, read top to bottom as the chain it went through: the discrepancy, the records, what the
// rules found, the AI's evidence, its proposal, the checker's verdict, and the human decision. The AI only ever
// proposes; the checker can refuse it; only a person approves. Everything shown is the server's own record.

const FILTERS = [
  ['all', 'All'],
  ['waiting', 'Needs you'],
  ['refused', 'Refused by checker'],
  ['unexamined', 'Not investigated'],
  ['degraded', 'Handed over'],
  ['resolved', 'Resolved'],
] as const;
type Filter = (typeof FILTERS)[number][0];
const isFilter = (f: string | undefined): f is Filter => FILTERS.some(([k]) => k === f);

const PAGE = 25;

const AUTHOR: Record<string, { icon: IconName; text: string; tone: string }> = {
  scripted: { icon: 'code', text: 'Scripted stand-in (not a language model)', tone: 'plain' },
  planted: {
    icon: 'flag',
    text: 'PLANTED by the demo to show the checker (not model output)',
    tone: 'warn',
  },
  model: { icon: 'bot', text: 'Language model', tone: 'ai' },
  harness: {
    icon: 'alert',
    text: 'Nobody: the system handed this to a person without a conclusion',
    tone: 'warn',
  },
};

const RECORD_ICON: Record<string, IconName> = {
  ledger_entry: 'book',
  rzp_payment: 'rupee',
  rzp_refund: 'refresh',
  rzp_settlement: 'layers',
  bank_line: 'bank',
};

/** The reviewer name the API records when the auto-accept policy, not a person, accepted a proposal. */
const AUTO_REVIEWER = 'auto-accept policy';

/** Where an exception stands, as one money state, an icon and two or three words. */
function standing(e: ExceptionRow): { state: MoneyState; icon?: IconName; text: string } {
  if (e.status === 'resolved')
    return e.review?.reviewer === AUTO_REVIEWER
      ? { state: 'ai', text: 'Auto-accepted' }
      : { state: 'you', text: e.review ? `${words(e.review.decision)}` : 'Resolved' };
  if (e.status === 'proposed') return { state: 'wait', text: 'Needs you' };
  if (e.status === 'dismissed') return { state: 'ignored', text: 'Dismissed' };
  if (e.proposal?.degradedLabel) return { state: 'open', icon: 'alert', text: 'Agent stopped' };
  if (e.proposal?.verifier === 'rejected') return { state: 'open', icon: 'x', text: 'Refused' };
  if (e.listedForAPerson) return { state: 'open', icon: 'user', text: 'For a person' };
  return { state: 'open', text: 'Open' };
}

function StateBadge({ e }: { e: ExceptionRow }) {
  const s = standing(e);
  return (
    <span className={`pill st ${STATE[s.state].className}`}>
      <Icon name={s.icon ?? STATE[s.state].icon} size={13} /> {s.text}
    </span>
  );
}

export function ExceptionsTab({
  runId,
  selected,
  overview,
  initial,
  onDecided,
  readOnly,
}: {
  runId: string;
  selected: string | null;
  overview: Overview | null;
  /** The view a link asked for (the dashboard's "Why the rules stopped" opens a reason). */
  initial: ListQuery | null;
  onDecided: () => void;
  /** A featured replay or an archived run: nothing here can be approved or rejected. */
  readOnly: boolean;
}) {
  const [filter, setFilter] = useState<Filter>(isFilter(initial?.filter) ? initial.filter : 'all');
  const [reason, setReason] = useState<string>(initial?.reason ?? '');
  const [page, setPage] = useState(0);
  // A new link (a reason picked on the overview) replaces the view.
  useEffect(() => {
    if (initial === null) return;
    if (isFilter(initial.filter)) setFilter(initial.filter);
    setReason(initial.reason ?? '');
    setPage(0);
  }, [initial?.filter, initial?.reason]);

  const path = `/runs/${runId}/exceptions?filter=${filter}&limit=${PAGE}&offset=${page * PAGE}${reason ? `&reason=${reason}` : ''}`;
  const list = useLoad<ExceptionList>(path);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  // With nothing chosen yet, the first case is shown, so the case file is never an empty half-page.
  const shown = selected ?? items[0]?.id ?? null;
  const at = items.findIndex((e) => e.id === shown);

  const reasons = overview?.exceptionsByReason ?? [];
  const inReason = reason ? reasons.filter((r) => r.reasonCode === reason) : reasons;
  const counts: Partial<Record<Filter, number>> = overview
    ? {
        all: inReason.reduce((n, r) => n + r.total, 0),
        waiting: inReason.reduce((n, r) => n + r.proposed, 0),
        resolved: inReason.reduce((n, r) => n + r.resolved, 0),
      }
    : {};

  // On a phone the case file sits under the list: a picked case moves up and comes into view.
  useEffect(() => {
    if (selected === null || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 960px)').matches)
      document.querySelector('.casefile-col')?.scrollIntoView({ block: 'start' });
  }, [selected]);

  const choose = (f: Filter) => {
    setFilter(f);
    setPage(0);
  };

  return (
    <div className={`exc-layout ${selected ? 'has-selection' : ''}`}>
      <section className="triage" aria-label="Exceptions">
        <div className="triage-head">
          <div className="segmented wrap-ok" role="tablist" aria-label="Show">
            {FILTERS.map(([f, label]) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={filter === f ? 'on' : ''}
                onClick={() => choose(f)}
              >
                {label}
                {counts[f] !== undefined ? <span className="seg-n">{counts[f]}</span> : null}
              </button>
            ))}
          </div>
          <label className="reason-pick">
            <span className="sr-only">Reason</span>
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Every reason</option>
              {reasons.map((r) => (
                <option key={r.reasonCode} value={r.reasonCode}>
                  {sentence(r.reasonCode)} ({r.total})
                </option>
              ))}
            </select>
          </label>
          <p className="triage-sort">
            <Icon name="trend" size={13} /> Largest at stake first
            {list.data ? (
              <span>
                {total === 0
                  ? 'none'
                  : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total}`}
              </span>
            ) : null}
          </p>
        </div>

        {list.error ? (
          <Banner tone="bad" role="alert">
            {list.error}
          </Banner>
        ) : null}

        <ol className={`xlist ${list.data === null ? 'loading' : ''}`}>
          {items.map((e) => {
            const s = standing(e);
            return (
              <li key={e.id}>
                <a
                  href={linkTo(runId, 'exceptions', e.id)}
                  className={`xrow ${STATE[s.state].className} ${e.id === shown ? 'sel' : ''}`}
                  aria-current={e.id === shown ? 'true' : undefined}
                >
                  <span className="xbar" aria-hidden="true" />
                  <span className="xmain">
                    <b className="xkey">{e.subject?.key ?? e.id.slice(0, 8)}</b>
                    <span className="xwhy">
                      {sentence(e.reasonCode)}
                      {e.ageDays === null ? '' : ` · ${e.ageDays}d`}
                    </span>
                  </span>
                  <span className="xside">
                    <b className="xamt">{inr(e.amountAtStakePaise)}</b>
                    <span className="xstate">
                      <Icon name={s.icon ?? STATE[s.state].icon} size={12} /> {s.text}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
        {list.data === null && !list.error
          ? [0, 1, 2, 3, 4, 5].map((n) => <div key={n} className="skel row-skel" />)
          : null}
        {list.data && items.length === 0 ? (
          <p className="empty">
            <Icon name="check" size={18} /> Nothing in this view.
          </p>
        ) : null}
        {total > PAGE ? (
          <div className="pager">
            <button
              type="button"
              className="sm"
              disabled={page === 0}
              onClick={() => setPage((n) => n - 1)}
            >
              ← Previous
            </button>
            <span>
              Page {page + 1} of {Math.ceil(total / PAGE)}
            </span>
            <button
              type="button"
              className="sm"
              disabled={(page + 1) * PAGE >= total}
              onClick={() => setPage((n) => n + 1)}
            >
              Next →
            </button>
          </div>
        ) : null}
      </section>

      <section className="casefile-col" aria-label="Case file">
        {shown ? (
          <CaseFile
            key={shown}
            runId={runId}
            id={shown}
            readOnly={readOnly}
            prev={at > 0 ? (items[at - 1]?.id ?? null) : null}
            next={at >= 0 && at < items.length - 1 ? (items[at + 1]?.id ?? null) : null}
            onChanged={() => {
              list.reload();
              onDecided();
            }}
          />
        ) : (
          <div className="card empty-detail">
            <span className="ico">
              <Icon name="search" size={20} />
            </span>
            <h3>Nothing to show</h3>
            <p>Pick another view to see exceptions.</p>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- the case file ----------

type StepState = 'done' | 'now' | 'bad' | 'skip' | 'todo';
interface TrailStep {
  id: string;
  label: string;
  state: StepState;
}

/** Where the case is along the chain, from the server's record of it. */
function trail(d: ExceptionDetail): TrailStep[] {
  const e = d.exception;
  const p = d.proposals.at(-1);
  const evidence: StepState = p
    ? p.evidence.length > 0
      ? 'done'
      : p.degraded
        ? 'bad'
        : 'skip'
    : e.listedForAPerson
      ? 'skip'
      : 'todo';
  const checker: StepState = !p
    ? e.listedForAPerson
      ? 'skip'
      : 'todo'
    : p.verifier.status === 'passed'
      ? 'done'
      : p.verifier.status === 'rejected'
        ? 'bad'
        : 'skip';
  const decision: StepState = p?.review
    ? p.review.decision === 'approved'
      ? 'done'
      : 'bad'
    : e.status === 'proposed'
      ? 'now'
      : e.status === 'resolved'
        ? 'done'
        : e.listedForAPerson || p?.verifier.status === 'rejected' || p?.degraded
          ? 'now'
          : 'todo';
  return [
    { id: 'c-discrepancy', label: 'Discrepancy', state: 'done' },
    { id: 'c-records', label: 'Records', state: 'done' },
    { id: 'c-rules', label: 'Rules', state: 'done' },
    { id: 'c-evidence', label: 'AI evidence', state: evidence },
    { id: 'c-proposal', label: 'Proposal', state: p ? (p.degraded ? 'bad' : 'done') : evidence },
    { id: 'c-checker', label: 'Checker', state: checker },
    { id: 'c-decision', label: 'Decision', state: decision },
  ];
}

const STEP_ICON: Record<StepState, IconName> = {
  done: 'check',
  now: 'user',
  bad: 'x',
  skip: 'minus',
  todo: 'clock',
};

function CaseFile({
  runId,
  id,
  readOnly,
  prev,
  next,
  onChanged,
}: {
  runId: string;
  id: string;
  readOnly: boolean;
  prev: string | null;
  next: string | null;
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
      <div className="card casefile" aria-busy="true">
        <div className="skel skel-line w60" />
        <div className="skel skel-block" />
        <div className="skel skel-block tall" />
      </div>
    );
  const { exception: e, subject, candidates, proposals } = d.data;
  const latest = proposals.at(-1);
  const steps = trail(d.data);
  const decidable =
    !readOnly &&
    latest !== undefined &&
    e.status === 'proposed' &&
    latest.review === null &&
    latest.verifier.status !== 'rejected';

  return (
    <article className="card casefile slide-in">
      <header className="cf-head">
        <div className="cf-title">
          <span className="kicker">{sentence(e.reasonCode)}</span>
          <h2>{subject?.key ?? 'Exception'}</h2>
          <div className="cf-meta">
            <StateBadge e={e} />
            {e.ageDays === null ? null : <span className="muted">{e.ageDays} days old</span>}
          </div>
        </div>
        <div className="cf-stake">
          <span className="kicker">At stake</span>
          <b>{inr(e.amountAtStakePaise)}</b>
        </div>
        <nav className="cf-nav" aria-label="Other cases on this page">
          {prev ? (
            <a className="button sm ghost" href={linkTo(runId, 'exceptions', prev)}>
              ← Prev
            </a>
          ) : null}
          {next ? (
            <a className="button sm ghost" href={linkTo(runId, 'exceptions', next)}>
              Next →
            </a>
          ) : null}
        </nav>
      </header>

      <ol className="cf-trail" aria-label="Where this case stands">
        {steps.map((s) => (
          <li key={s.id} className={s.state}>
            <a href={`#${s.id}`} onClick={(ev) => jump(ev, s.id)}>
              <span className="cf-dot">
                <Icon name={STEP_ICON[s.state]} size={12} />
              </span>
              <span>{s.label}</span>
            </a>
          </li>
        ))}
      </ol>

      <div className="cf-guard">
        <Icon name="shield" size={15} />
        <span>
          The AI only <b>proposes</b>. The checker re-computes it from the records and can refuse
          it. Only a <b>person</b> can approve a match.
        </span>
      </div>

      <Block id="c-discrepancy" n={1} title="The discrepancy">
        <p className="cf-lead">{e.nextStep}</p>
        {e.note ? <p className="free muted">{e.note}</p> : null}
        {e.cause ? (
          <p className="free muted">
            <b>Cause recorded:</b> {e.cause}
          </p>
        ) : null}
      </Block>

      <Block
        id="c-records"
        n={2}
        title="The records"
        aside={`${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`}
      >
        <RecordsCompare runId={runId} subject={subject} candidates={candidates} />
      </Block>

      <Block id="c-rules" n={3} title="What the rules found">
        <div className="cf-rule">
          <span className="pill">
            <Icon name="code" size={13} /> {e.reasonCode}
          </span>
          <p>{reasonMeaning(e.reasonCode)}</p>
        </div>
        <p className="muted">
          {candidates.length === 0
            ? 'No record fitted, so no rule could match it.'
            : candidates.length === 1
              ? 'One record could fit, but not exactly enough for a rule to prove it.'
              : `${candidates.length} records could fit. More than one candidate is ambiguity, and the rules never guess.`}
          {e.listedForAPerson
            ? ' It was listed for a person: there is nothing for the AI to find.'
            : ''}
        </p>
      </Block>

      {latest ? (
        <>
          <Block
            id="c-evidence"
            n={4}
            title="The AI’s evidence"
            aside={`${latest.evidence.length} lookup${latest.evidence.length === 1 ? '' : 's'}`}
          >
            <Author p={latest} attempts={proposals.length} />
            {latest.degradedLabel ? (
              <Banner tone="warn">
                <b>The agent did not reach a conclusion:</b> {latest.degradedLabel}. This is the
                system handing the exception to a person, not a finding about the records.
              </Banner>
            ) : null}
            <ol className="evidence">
              {latest.evidence.map((ev, i) => (
                <li key={i} style={{ ['--i' as string]: i }}>
                  <span className="ev-n">{i + 1}</span>
                  <div>
                    <span className="free">{ev.keyFinding}</span>
                    <div className="ev-src">
                      <code>{ev.tool}</code>
                      <code className="ev-args">{JSON.stringify(ev.args)}</code>
                      <span className="ev-ro">read-only</span>
                    </div>
                  </div>
                </li>
              ))}
              {latest.evidence.length === 0 ? (
                <li className="muted">No evidence was attached.</li>
              ) : null}
            </ol>
            {latest.harnessFindings.length > 0 ? (
              <ul className="muted free findings-list">
                {latest.harnessFindings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : null}
          </Block>

          <Block id="c-proposal" n={5} title="The proposal">
            <ProposalBody runId={runId} p={latest} />
          </Block>

          <Block id="c-checker" n={6} title="The checker’s verdict">
            <CheckerBlock p={latest} />
          </Block>
        </>
      ) : (
        <Block id="c-evidence" n={4} title="AI investigation">
          <p className="muted">
            {e.listedForAPerson
              ? 'Not sent to the agent: this one is listed for a person.'
              : 'The agent has not looked at this one yet.'}
          </p>
        </Block>
      )}

      <Block id="c-decision" n={latest ? 7 : 5} title="Your decision" last>
        {latest ? (
          <Decision
            p={latest}
            decidable={decidable}
            readOnly={readOnly}
            onDone={() => {
              d.reload();
              onChanged();
            }}
          />
        ) : (
          <p className="muted">
            Nothing to approve yet: there is no proposal. Use the records above and the audit trail
            to settle it by hand.
          </p>
        )}
      </Block>
    </article>
  );
}

/** Scrolls to a section without changing the hash (the hash is the route). */
function jump(ev: MouseEvent, id: string) {
  ev.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Block({
  id,
  n,
  title,
  aside,
  last = false,
  children,
}: {
  id: string;
  n: number;
  title: string;
  aside?: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`cf-block ${last ? 'last' : ''}`}>
      <span className="cf-n" aria-hidden="true">
        {n}
      </span>
      <div className="cf-body">
        <h3>
          {title}
          {aside ? <span className="cf-aside">{aside}</span> : null}
        </h3>
        {children}
      </div>
    </section>
  );
}

/** The subject and its candidates side by side, each amount compared with the subject's, to the paisa. */
function RecordsCompare({
  runId,
  subject,
  candidates,
}: {
  runId: string;
  subject: Described | null;
  candidates: Described[];
}) {
  const base = subject && /^-?\d+$/.test(subject.amountPaise) ? BigInt(subject.amountPaise) : null;
  const rows: { role: string; r: Described }[] = [
    ...(subject ? [{ role: 'Subject', r: subject }] : []),
    ...candidates.map((r, i) => ({ role: `Candidate ${i + 1}`, r })),
  ];
  if (rows.length === 0) return <p className="muted">No records are attached.</p>;
  return (
    <div className="table-wrap">
      <table className="data compare">
        <thead>
          <tr>
            <th>Record</th>
            <th>Date</th>
            <th className="n">Amount</th>
            <th className="n">vs subject</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ role, r }) => {
            const diff =
              base !== null && role !== 'Subject' && /^-?\d+$/.test(r.amountPaise)
                ? BigInt(r.amountPaise) - base
                : null;
            return (
              <tr key={`${role}-${r.id}`} className={role === 'Subject' ? 'subject' : ''}>
                <td>
                  <span className="rec-cell">
                    <span className="rec-ico">
                      <Icon name={RECORD_ICON[r.type] ?? 'file'} size={15} />
                    </span>
                    <span>
                      <a href={linkTo(runId, 'audit', r.id)} title="Open the audit trail">
                        {r.key}
                      </a>
                      <span className="row-sub free">
                        {role} · {words(r.type)}
                        {r.detail ? ` · ${r.detail}` : ''}
                      </span>
                    </span>
                  </span>
                </td>
                <td>{r.date ?? '–'}</td>
                <td className="n">{inr(r.amountPaise)}</td>
                <td className="n">
                  {diff === null ? (
                    <span className="muted">–</span>
                  ) : diff === 0n ? (
                    <span className="eq">
                      <Icon name="check" size={12} /> equal
                    </span>
                  ) : (
                    <span className="neq">
                      {diff > 0n ? '+' : '−'}
                      {inr(String(diff < 0n ? -diff : diff))}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Author({ p, attempts }: { p: ProposalDetail; attempts: number }) {
  const author = AUTHOR[p.author] ?? { icon: 'bot' as const, text: p.author, tone: 'ai' };
  return (
    <p className={`author ${author.tone}`}>
      <Icon name={author.icon} size={15} /> <span>{author.text}</span>
      {p.model ? <code>{p.model}</code> : null}
      {attempts > 1 ? (
        <span className="muted">
          attempt {p.attempt} of {attempts}
        </span>
      ) : null}
    </p>
  );
}

function ProposalBody({ runId, p }: { runId: string; p: ProposalDetail }) {
  return (
    <>
      <div className="verdict-row">
        <span className="pill info">
          <Icon name="sparkle" size={13} /> {words(p.verdict)}
        </span>
        <span className="pill">suggested: {words(p.suggestedAction)}</span>
        <span className="pill">{sentence(p.reasonCode)}</span>
      </div>
      <div className="confidence">
        <span>Agent confidence</span>
        <Meter value={p.confidence} label="Agent confidence" />
        <b>{Math.round(p.confidence * 100)}%</b>
      </div>
      <blockquote className="quote free">{p.explanation}</blockquote>
      {p.links.length > 0 ? (
        <div className="links">
          <span className="kicker">Records it links</span>
          <ul>
            {p.links.map((l) => (
              <li key={l.id}>
                <Icon name={RECORD_ICON[l.type] ?? 'file'} size={14} />
                <a href={linkTo(runId, 'audit', l.id)}>{l.key}</a>
                <b>{inr(l.amountPaise)}</b>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.draftJournalEntry ? (
        <details className="fold-table" open>
          <summary>
            Draft journal entry <Icon name="arrow" size={13} />
          </summary>
          <p className="free muted">{p.draftJournalEntry.memo}</p>
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
        </details>
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
            ? 'Verified by code'
            : bad
              ? 'Refused by code'
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

function Decision({
  p,
  decidable,
  readOnly,
  onDone,
}: {
  p: ProposalDetail;
  decidable: boolean;
  readOnly: boolean;
  onDone: () => void;
}) {
  const [reviewer, setReviewer] = useState('a visitor');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const decide = async (what: 'approve' | 'reject') => {
    setBusy(what);
    setProblem(null);
    try {
      await post(`/proposals/${p.id}/${what}`, {
        reviewer: reviewer.trim() || 'a visitor',
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (p.review)
    return (
      <div className={`decided ${p.review.decision === 'approved' ? 'ok' : 'bad'}`} role="status">
        <span className="decided-ico">
          <Icon name={p.review.decision === 'approved' ? 'check' : 'x'} size={20} />
        </span>
        <div>
          <b>
            {p.review.decision} by {p.review.reviewer}
          </b>
          <span className="muted"> · {new Date(p.review.at).toLocaleString()}</span>
          {p.review.note ? <p className="muted">{p.review.note}</p> : null}
        </div>
      </div>
    );
  if (readOnly)
    return (
      <p className="muted block">
        <Icon name="lock" size={14} /> Read-only run. Start your own to approve or reject.
      </p>
    );
  if (p.verifier.status === 'rejected')
    return (
      <p className="muted block">
        The checker refused this proposal, so it cannot be approved. The exception stays open for a
        person to settle.
      </p>
    );
  if (!decidable)
    return <p className="muted block">There is nothing to decide on this proposal.</p>;
  return (
    <div className="decide">
      <div className="decide-fields">
        <label>
          <span>Your name</span>
          <input
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            maxLength={100}
            autoComplete="name"
          />
        </label>
        <label>
          <span>Note (required to reject)</span>
          <textarea
            placeholder="Why you decided this"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
        </label>
      </div>
      <div className="decide-actions">
        <button className="primary" disabled={busy !== null} onClick={() => void decide('approve')}>
          {busy === 'approve' ? <span className="spinner" /> : <Icon name="check" size={16} />}{' '}
          Approve match
        </button>
        <button
          disabled={busy !== null || note.trim() === ''}
          onClick={() => void decide('reject')}
          title={note.trim() === '' ? 'Write a note to reject' : undefined}
        >
          {busy === 'reject' ? <span className="spinner" /> : <Icon name="x" size={16} />} Reject
        </button>
        <span className="muted small">
          Approving re-verifies first; a stale proposal is refused.
        </span>
      </div>
      {problem ? (
        <Banner tone="bad" role="alert">
          {problem}
        </Banner>
      ) : null}
    </div>
  );
}
