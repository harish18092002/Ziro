import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, get, type Overview, type Progress, post } from './api';
import { AuditTab } from './Audit';
import { toBig } from './chart-math';
import {
  type BarItem,
  BarList,
  ChartCard,
  DataTable,
  Legend,
  Meter,
  RingMeter,
  type StackRow,
  StackedBars,
} from './Charts';
import { ExceptionsTab } from './Exceptions';
import {
  dollars,
  failureSentence,
  inr,
  linkTo,
  percent,
  type Route,
  sentence,
  type Tab,
  words,
} from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { Banner, Count, CountPaise, Reveal, StatTile } from './ui';

type RunRoute = Extract<Route, { page: 'run' }>;

const TAB_NAMES: Record<Tab, string> = {
  summary: 'Summary',
  exceptions: 'Exceptions',
  audit: 'Audit',
  downloads: 'Downloads',
};
const TAB_ICONS: Record<Tab, IconName> = {
  summary: 'trend',
  exceptions: 'search',
  audit: 'list',
  downloads: 'download',
};

export function RunPage({ route }: { route: RunRoute }) {
  const progress = useProgress(route.runId);
  // One overview for the banners above the tabs and for the Summary tab.
  const overview = useLoad<Overview>(
    progress?.stage === 'ready' || progress?.stage === 'unknown'
      ? `/runs/${route.runId}/overview`
      : null,
  );
  if (progress === null) return <RunSkeleton />;
  if (progress.stage === 'failed')
    return (
      <Banner tone="bad" role="alert">
        <b>This run failed:</b> {progress.error ?? 'no reason recorded'}.
      </Banner>
    );
  if (progress.stage !== 'ready' && progress.stage !== 'unknown') return <Working p={progress} />;

  return (
    <div className="run page">
      {overview.data ? <RunBanners o={overview.data} runId={route.runId} /> : null}
      {overview.data ? <RunHeader o={overview.data} runId={route.runId} /> : null}
      <nav className="tabs" aria-label="Run sections">
        {(Object.keys(TAB_NAMES) as Tab[]).map((t) => (
          <a
            key={t}
            href={linkTo(route.runId, t)}
            className={t === route.tab ? 'on' : ''}
            aria-current={t === route.tab ? 'page' : undefined}
          >
            <Icon name={TAB_ICONS[t]} size={16} />
            {TAB_NAMES[t]}
          </a>
        ))}
      </nav>
      <div className="tab-body" key={route.tab}>
        {route.tab === 'summary' && (
          <Summary runId={route.runId} o={overview.data} error={overview.error} />
        )}
        {route.tab === 'exceptions' && (
          <ExceptionsTab
            runId={route.runId}
            selected={route.itemId}
            readOnly={
              overview.data !== null &&
              (overview.data.run.featured !== null || overview.data.run.archived)
            }
          />
        )}
        {route.tab === 'audit' && <AuditTab runId={route.runId} selected={route.itemId} />}
        {route.tab === 'downloads' && <Downloads runId={route.runId} />}
      </div>
    </div>
  );
}

/** Polls a run until it is ready (or failed), then stops. */
function useProgress(runId: string): Progress | null {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await get<Progress>(`/runs/${runId}/progress`);
        if (!live) return;
        setP(next);
        if (next.stage === 'matching' || next.stage === 'investigating')
          timer = setTimeout(() => void tick(), 600);
      } catch {
        if (live) timer = setTimeout(() => void tick(), 2_000);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);
  return p;
}

function RunSkeleton() {
  return (
    <div className="run">
      <div className="skel" style={{ height: 44, width: 320, marginBottom: 20 }} />
      <div className="skel" style={{ height: 150, marginBottom: 20 }} />
      <div className="tiles">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="skel tile-skel" />
        ))}
      </div>
    </div>
  );
}

// ---------- while the run is working ----------

const STAGES = [
  {
    stage: 'matching',
    icon: 'code',
    title: 'Rules match',
    text: 'What can be proved, to the paise',
  },
  {
    stage: 'investigating',
    icon: 'bot',
    title: 'Agent investigates',
    text: 'The leftovers, with the checker re-computing every claim',
  },
  {
    stage: 'ready',
    icon: 'check',
    title: 'Ready to review',
    text: 'Exceptions, evidence, audit trail',
  },
] as const satisfies readonly { stage: string; icon: IconName; title: string; text: string }[];

function Working({ p }: { p: Progress }) {
  const at = STAGES.findIndex((s) => s.stage === p.stage);
  const share = p.expected ? Math.min(1, p.counts.proposals / p.expected) : 0;
  return (
    <section className="working page" aria-live="polite">
      <div className="working-head">
        <span className="spinner big" />
        <div>
          <h1>Working on your batch</h1>
          <p className="muted">This usually takes a couple of seconds.</p>
        </div>
      </div>
      <ol className="pipeline">
        {STAGES.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'now' : 'todo';
          return (
            <li key={s.stage} className={state}>
              <span className="node">
                {state === 'done' ? (
                  <Icon name="check" size={18} />
                ) : (
                  <Icon name={s.icon} size={18} />
                )}
              </span>
              <div>
                <b>{s.title}</b>
                <span>{s.text}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {p.stage === 'investigating' && p.expected ? (
        <div className="working-meter">
          <div className="working-meter-head">
            <span>
              {p.counts.proposals} of {p.expected} exceptions investigated
            </span>
            <b>{percent(share)}</b>
          </div>
          <Meter value={share} label="Investigations finished" />
        </div>
      ) : (
        <div className="indeterminate" aria-hidden="true">
          <span />
        </div>
      )}
      <div className="tiles">
        <StatTile label="Groups proved" icon="check" tone="good">
          {p.counts.groups}
        </StatTile>
        <StatTile label="Exceptions" icon="search" tone="open">
          {p.counts.exceptions}
        </StatTile>
        <StatTile label="Investigated" icon="bot" tone="waiting">
          {p.counts.proposals}
        </StatTile>
        <StatTile label="Refused by the checker" icon="shield" tone="fee">
          {p.counts.refused}
        </StatTile>
      </div>
    </section>
  );
}

// ---------- header, banners ----------

/** Archives this run and starts a fresh scripted one; the server keeps the old rows (the audit trail is append-only). */
function ResetDemo({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reset = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { runId: fresh } = await post<{ runId: string }>('/demo/reset', { runId });
      window.location.hash = linkTo(fresh);
    } catch (e) {
      setBusy(false);
      setProblem(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="reset">
      <button className="sm" disabled={busy} onClick={() => void reset()}>
        {busy ? <span className="spinner" /> : <Icon name="refresh" size={15} />}
        {busy ? 'Resetting…' : 'Reset demo'}
      </button>
      {problem ? <span className="bad-text"> {problem}</span> : null}
    </div>
  );
}

function RunHeader({ o, runId }: { o: Overview; runId: string }) {
  const featured = o.run.featured !== null;
  const scripted = o.llm.agent === 'scripted';
  return (
    <header className="run-head">
      <div>
        <span className="kicker">
          {featured ? 'Replay, read-only' : o.run.archived ? 'Archived run' : 'Your run'}
        </span>
        <h1>{o.run.preset === 'eval' ? '500-order reconciliation' : '50-order reconciliation'}</h1>
        <div className="chips-row">
          <span className="pill">
            <Icon name="clock" size={13} /> as of {o.run.asOf}
          </span>
          <span className={`pill ${scripted ? '' : 'info'}`}>
            <Icon name={scripted ? 'code' : 'bot'} size={13} />
            {scripted ? 'scripted baseline, not a language model' : (o.llm.agent ?? 'no agent')}
          </span>
          {o.time.seconds === null ? null : (
            <span className="pill">
              <Icon name="bolt" size={13} /> {o.time.seconds} s wall time
            </span>
          )}
          {o.reconciles ? (
            <span className="pill ok">
              <Icon name="check" size={13} /> totals add up to the paise
            </span>
          ) : (
            <span className="pill bad">
              <Icon name="x" size={13} /> totals do NOT add up
            </span>
          )}
        </div>
      </div>
      {o.run.featured === null && !o.run.archived ? <ResetDemo runId={runId} /> : null}
    </header>
  );
}

/**
 * What a person must know before reading any number on this run: Razorpay did not return everything
 * (PARTIAL), the agent stopped early, or the demo broke things on purpose. Shown on every tab.
 */
function RunBanners({ o, runId }: { o: Overview; runId: string }) {
  const handled = failureSentence(o.failures);
  return (
    <div className="run-banners">
      {o.run.featured !== null ? (
        <Banner>
          <b>Replay.</b> This is a precomputed run, shown read-only: it costs nothing and needs no
          API key. <a href="#/">Start your own run</a> to approve or reject proposals.
        </Banner>
      ) : null}
      {o.run.archived ? (
        <Banner tone="warn">
          <b>Archived.</b> This run was put away by “Reset demo”. You can still read it, but it can
          no longer be approved or rejected. <a href="#/">Start a new run</a>.
        </Banner>
      ) : null}
      {o.run.partial ? (
        <Banner tone="warn" role="alert">
          <b>PARTIAL RUN.</b> Razorpay did not return everything. What arrived was imported; this is
          missing:
          <ul>
            {o.run.gaps.map((g, i) => (
              <li key={i}>{g.detail}</li>
            ))}
          </ul>
          Exceptions such as “ledger without payment” or an unexplained settlement may be caused by
          the gap, not by a real discrepancy. Import again to fill in what is missing.
        </Banner>
      ) : null}
      {o.failures.note ? (
        <Banner tone="warn">{o.failures.note}. The exceptions it left are still open.</Banner>
      ) : null}
      {o.failures.injected ? (
        <Banner>
          <b>Chaos is on.</b> The demo broke three investigations on purpose: one where every model
          timed out, one where every model was out of quota, and one where a reply was cut off
          mid-JSON. {handled ?? ''} Nothing stopped: the run finished and all three went to a person
          with the reason. In <a href={linkTo(runId, 'exceptions')}>Exceptions</a>, the filter
          “Handed to a person by the system” shows them.
        </Banner>
      ) : handled ? (
        <Banner>{handled}</Banner>
      ) : null}
    </div>
  );
}

// ---------- summary dashboard ----------

const SOURCE_NAME: Record<string, string> = {
  ledger_entry: 'Ledger entries',
  rzp_payment: 'Razorpay payments',
  rzp_refund: 'Refunds',
  rzp_settlement: 'Settlements',
  bank_line: 'Bank lines',
};
const sourceName = (type: string): string => SOURCE_NAME[type] ?? words(type);

const METHOD_NAME: Record<string, string> = {
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
};
const methodName = (m: string): string => METHOD_NAME[m] ?? words(m);

const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);

function Summary({ runId, o, error }: { runId: string; o: Overview | null; error: string | null }) {
  if (error)
    return (
      <Banner tone="bad" role="alert">
        {error}
      </Banner>
    );
  if (o === null) return <RunSkeleton />;

  const { gap, sources: s } = o;
  const ledger = o.coverage.find((c) => c.type === 'ledger_entry');
  const reasons = o.exceptionsByReason;
  const excOpen = sum(reasons.map((r) => r.open));
  const excWaiting = sum(reasons.map((r) => r.proposed));
  const excTotal = sum(reasons.map((r) => r.total));

  const gapRow: StackRow = {
    id: 'gap',
    label: '',
    segments: [
      {
        key: 'explained',
        label: 'Explained and approved',
        value: toBig(gap.explainedPaise),
        color: 'var(--c-matched)',
        shown: inr(gap.explainedPaise),
      },
      {
        key: 'waiting',
        label: 'Waiting for a person',
        value: toBig(gap.awaitingPaise),
        color: 'var(--c-waiting)',
        shown: inr(gap.awaitingPaise),
      },
      {
        key: 'open',
        label: 'Not yet looked at',
        value: toBig(gap.openPaise),
        color: 'var(--c-open)',
        shown: inr(gap.openPaise),
      },
    ],
  };

  const coverageRows: StackRow[] = o.coverage.map((c) => ({
    id: c.type,
    label: sourceName(c.type),
    totalLabel: `${c.total}`,
    segments: [
      {
        key: 'matched',
        label: 'Matched',
        value: BigInt(c.matched),
        color: 'var(--c-matched)',
        detail: inr(c.amountPaise.matched),
      },
      {
        key: 'exception',
        label: 'In an exception',
        value: BigInt(c.inException),
        color: 'var(--c-open)',
        detail: inr(c.amountPaise.inException),
      },
      {
        key: 'ignored',
        label: 'Ignored',
        value: BigInt(c.ignored),
        color: 'var(--c-other)',
        detail: inr(c.amountPaise.ignored),
      },
    ],
  }));

  const tierItems: BarItem[] = o.matching.byTier.map((t, i) => ({
    id: t.label,
    label: t.label,
    sub: `${t.groups} groups`,
    value: BigInt(t.records),
    display: `${t.records} records · ${percent(t.share)}`,
    color: `var(--ord-${Math.min(i + 1, 4)})`,
  }));

  const reasonRows: StackRow[] = reasons.map((r) => ({
    id: r.reasonCode,
    label: sentence(r.reasonCode),
    href: linkTo(runId, 'exceptions'),
    totalLabel: `${r.total}`,
    segments: [
      { key: 'resolved', label: 'Resolved', value: BigInt(r.resolved), color: 'var(--c-matched)' },
      {
        key: 'waiting',
        label: 'Waiting for a person',
        value: BigInt(r.proposed),
        color: 'var(--c-waiting)',
      },
      { key: 'open', label: 'Open', value: BigInt(r.open), color: 'var(--c-open)' },
      { key: 'dismissed', label: 'Dismissed', value: BigInt(r.dismissed), color: 'var(--c-other)' },
    ],
  }));

  const ageItems: BarItem[] = o.openExceptions.byAge.map((b) => ({
    id: b.bucket,
    label: b.bucket,
    value: toBig(b.stakePaise),
    display: `${b.cases} cases · ${inr(b.stakePaise)}`,
    color: 'var(--c-open)',
  }));

  const r = o.resolution;
  const settledItems: BarItem[] = [
    {
      id: 'rules',
      label: 'Rule groups, proved by code',
      value: BigInt(r.ruleGroups),
      color: 'var(--c-matched)',
    },
    {
      id: 'agent-match',
      label: 'Agent match, approved by a person',
      value: BigInt(r.agentMatchesApprovedByPerson),
      color: 'var(--c-matched)',
    },
    {
      id: 'agent-explain',
      label: 'Agent explanation, approved by a person',
      value: BigInt(r.agentExplanationsApprovedByPerson),
      color: 'var(--c-matched)',
    },
    {
      id: 'auto',
      label: 'Agent proposal, auto-accepted',
      value: BigInt(r.autoAccepted),
      color: 'var(--c-matched)',
    },
    {
      id: 'rejected',
      label: 'Proposal rejected by a person',
      value: BigInt(r.rejectedByPerson),
      color: 'var(--c-other)',
    },
    {
      id: 'waiting',
      label: 'Waiting for a person',
      value: BigInt(r.waiting),
      color: 'var(--c-waiting)',
    },
  ].map((i) => ({ ...i, display: i.value.toString() }));

  const methodItems: BarItem[] = o.leakage.byMethod.map((m) => ({
    id: m.method,
    label: methodName(m.method),
    sub: `${m.overchargedCount} of ${m.assessed} payments overcharged`,
    value: toBig(m.excessPaise),
    display: inr(m.excessPaise),
    color: 'var(--c-fee)',
  }));

  return (
    <div className="dash">
      <Reveal className="span-2">
        <div className="hero-row">
          <section className="card gap-card">
            <span className="kicker">The Ziro gap: still unreconciled</span>
            <div className="gap-figure">
              <CountPaise paise={gap.gapPaise} />
            </div>
            <p className="muted">
              Goal: ₹0.00 unexplained. {inr(gap.openPaise)} is not yet looked at ({gap.cases.open}{' '}
              cases) and {inr(gap.awaitingPaise)} is waiting for a person ({gap.cases.awaiting}{' '}
              cases).
              {gap.cases.explained > 0
                ? ` ${inr(gap.explainedPaise)} has been explained (${gap.cases.explained} cases).`
                : ''}
            </p>
            <StackedBars rows={[gapRow]} tall />
            <Legend
              items={[
                {
                  key: 'explained',
                  label: 'Explained',
                  color: 'var(--c-matched)',
                  value: inr(gap.explainedPaise),
                },
                {
                  key: 'waiting',
                  label: 'Waiting for a person',
                  color: 'var(--c-waiting)',
                  value: inr(gap.awaitingPaise),
                },
                {
                  key: 'open',
                  label: 'Not yet looked at',
                  color: 'var(--c-open)',
                  value: inr(gap.openPaise),
                },
              ]}
            />
          </section>
          <section className="card ring-card">
            <RingMeter
              value={ledger?.matchRate ?? 0}
              label="Ledger entries matched"
              sub={
                ledger
                  ? `${ledger.matched} of ${ledger.matched + ledger.inException} that a rule could judge`
                  : undefined
              }
            />
          </section>
        </div>
      </Reveal>

      <Reveal className="span-2">
        <div className="tiles">
          <StatTile
            label="Groups proved by code"
            icon="code"
            hint={`${o.matching.matchedRecords} records matched, each re-checked`}
          >
            <Count value={o.resolution.ruleGroups} />
          </StatTile>
          <StatTile
            label="Exceptions"
            icon="search"
            tone="open"
            hint={`${excOpen} open · ${excWaiting} waiting for a person`}
          >
            <Count value={excTotal} />
          </StatTile>
          <StatTile
            label="Fee leakage"
            icon="rupee"
            tone="fee"
            hint={`over ${o.leakage.overchargedCount} of ${o.leakage.assessed} payments`}
          >
            <CountPaise paise={o.leakage.excessPaise} />
          </StatTile>
          <StatTile
            label="Delayed payouts"
            icon="clock"
            tone="warn"
            hint={
              o.delays.overdueCount > 0
                ? `${o.delays.overdueCount} overdue, ${inr(o.delays.overduePaise)}`
                : 'none overdue'
            }
          >
            <Count value={o.delays.delayedCount} />
          </StatTile>
        </div>
      </Reveal>

      <div className="span-2 masonry">
        <Reveal>
          <ChartCard
            title="Coverage by source"
            subtitle="Every record is in exactly one place: matched, in an exception, or ignored."
            legend={
              <Legend
                items={[
                  { key: 'm', label: 'Matched', color: 'var(--c-matched)' },
                  { key: 'e', label: 'In an exception', color: 'var(--c-open)' },
                  { key: 'i', label: 'Ignored', color: 'var(--c-other)' },
                ]}
              />
            }
            table={{
              columns: ['Source', 'Matched', 'In exception', 'Ignored', 'Match rate'],
              numeric: [1, 2, 3, 4],
              rows: o.coverage.map((c) => [
                sourceName(c.type),
                String(c.matched),
                String(c.inException),
                String(c.ignored),
                percent(c.matchRate),
              ]),
            }}
            foot="Match rate = matched ÷ (matched + in an exception). Ignored records are ones no rule should match, such as failed payments and bank debits."
          >
            <StackedBars rows={coverageRows} />
          </ChartCard>
        </Reveal>

        <Reveal i={1}>
          <ChartCard
            title="How records were matched"
            subtitle="Strictest rule first. Darker means a stricter test."
            table={{
              columns: ['How it was matched', 'Groups', 'Records', 'Share'],
              numeric: [1, 2, 3],
              rows: o.matching.byTier.map((t) => [
                t.label,
                String(t.groups),
                String(t.records),
                percent(t.share),
              ]),
            }}
          >
            <BarList items={tierItems} />
          </ChartCard>
        </Reveal>

        <Reveal>
          <ChartCard
            title="Exceptions by reason"
            subtitle="Where the rules stopped, and how far each reason has got."
            legend={
              <Legend
                items={[
                  { key: 'r', label: 'Resolved', color: 'var(--c-matched)' },
                  { key: 'w', label: 'Waiting for a person', color: 'var(--c-waiting)' },
                  { key: 'o', label: 'Open', color: 'var(--c-open)' },
                ]}
              />
            }
            table={{
              columns: ['Reason', 'Total', 'Open', 'Waiting', 'Resolved'],
              numeric: [1, 2, 3, 4],
              rows: reasons.map((x) => [
                sentence(x.reasonCode),
                String(x.total),
                String(x.open),
                String(x.proposed),
                String(x.resolved),
              ]),
            }}
            foot={
              <a className="button sm" href={linkTo(runId, 'exceptions')}>
                Review the exceptions <Icon name="arrow" size={15} />
              </a>
            }
          >
            {reasonRows.length > 0 ? (
              <StackedBars rows={reasonRows} />
            ) : (
              <p className="empty">
                <Icon name="check" size={18} /> No exceptions.
              </p>
            )}
          </ChartCard>
        </Reveal>

        <Reveal i={1}>
          <ChartCard
            title="Unsettled by age"
            subtitle={`As of ${o.openExceptions.asOf}, counted from each record's own date.`}
            table={{
              columns: ['Age', 'Cases', 'At stake'],
              numeric: [1, 2],
              rows: o.openExceptions.byAge.map((b) => [
                b.bucket,
                String(b.cases),
                inr(b.stakePaise),
              ]),
            }}
          >
            {ageItems.length > 0 ? (
              <BarList items={ageItems} />
            ) : (
              <p className="empty">
                <Icon name="check" size={18} /> Nothing unsettled.
              </p>
            )}
          </ChartCard>
        </Reveal>

        <Reveal>
          <ChartCard
            title="How things were settled"
            subtitle="Who closed each case: code, the agent with a person, or nobody yet."
            table={{
              columns: ['How', 'Count'],
              numeric: [1],
              rows: settledItems.map((i) => [i.label, i.display]),
            }}
          >
            <BarList items={settledItems} />
          </ChartCard>
        </Reveal>

        <Reveal i={1}>
          <section className="card facts">
            <h3 className="card-title">Run facts</h3>
            <dl>
              <Fact icon="bot" label="Agent">
                {o.llm.agent === 'scripted'
                  ? 'Scripted baseline (not a language model)'
                  : (o.llm.agent ?? 'none')}
              </Fact>
              <Fact icon="bolt" label="Model calls">
                {o.llm.calls}
              </Fact>
              <Fact icon="scale" label="Model cost">
                {dollars(o.llm.costUsd)}
              </Fact>
              <Fact icon="flag" label="Handed to a person without a conclusion">
                {o.failures.handedToAPerson}
              </Fact>
              <Fact icon="clock" label="Wall time for the run">
                {o.time.seconds === null ? '–' : `${o.time.seconds} s`}
              </Fact>
              <Fact icon="user" label="Approved by a person">
                {o.matching.approvedByPerson}
              </Fact>
            </dl>
          </section>
        </Reveal>

        <Reveal>
          <section className="card feature-card">
            <div className="card-head">
              <div>
                <h3 className="card-title">Fee leakage</h3>
                <p className="card-sub">Charged above your fee contract.</p>
              </div>
            </div>
            <div className="big-figure fee">
              <CountPaise paise={o.leakage.excessPaise} />
            </div>
            <p className="muted">
              On {o.leakage.overchargedCount} of {o.leakage.assessed} payments: base fee{' '}
              {inr(o.leakage.excessBasePaise)} plus GST {inr(o.leakage.excessGstPaise)}.
              {o.leakage.contract.source === 'default'
                ? ' The run stored no fee contract, so the default was used.'
                : ''}
              {o.leakage.notAssessable > 0
                ? ` ${o.leakage.notAssessable} payments could not be judged (method or currency not in the contract).`
                : ''}
              {o.leakage.undercharged.count > 0
                ? ` Separately, ${o.leakage.undercharged.count} were charged ${inr(o.leakage.undercharged.shortfallPaise)} below the contract; that is not netted.`
                : ''}
            </p>
            {methodItems.length > 0 ? <BarList items={methodItems} /> : null}
            {o.leakage.worst.length > 0 ? (
              <>
                <h4 className="mini-title">Largest overcharges</h4>
                <DataTable
                  columns={['Payment', 'Method', 'Expected', 'Charged', 'Excess']}
                  numeric={[2, 3, 4]}
                  rows={o.leakage.worst
                    .slice(0, 5)
                    .map((w) => [
                      w.rzpId,
                      methodName(w.method),
                      inr(w.expectedFeePaise),
                      inr(w.actualFeePaise),
                      inr(w.excessPaise),
                    ])}
                />
              </>
            ) : null}
          </section>
        </Reveal>

        <Reveal i={1}>
          <section className="card feature-card">
            <div className="card-head">
              <div>
                <h3 className="card-title">Delayed settlements</h3>
                <p className="card-sub">Paid out later than the normal lag.</p>
              </div>
            </div>
            <div className="big-figure">
              <Count value={o.delays.delayedCount} />
            </div>
            <p className="muted">
              Settlements worth {inr(o.delays.delayedPaise)} arrived late.{' '}
              {o.delays.overdueCount > 0
                ? `${o.delays.overdueCount} (${inr(o.delays.overduePaise)}) have no bank credit yet and are overdue.`
                : 'None is overdue.'}
            </p>
            {o.delays.delayed.length > 0 ? (
              <DataTable
                columns={['Settlement', 'Due', 'Created', 'Days late', 'Amount']}
                numeric={[3, 4]}
                rows={o.delays.delayed.map((d) => [
                  d.rzpId,
                  d.dueDate ?? '–',
                  d.settlementDate,
                  d.createdLate ? String(d.businessDaysLate) : 'credit late',
                  inr(d.amountPaise),
                ])}
              />
            ) : (
              <p className="empty">
                <Icon name="check" size={18} /> No delayed settlements.
              </p>
            )}
          </section>
        </Reveal>
      </div>

      <Reveal className="span-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Do the totals add up?</h3>
              <p className="card-sub">
                Counted separately for every source, so a row that did not add up would show a
                cross.
              </p>
            </div>
            {o.reconciles ? (
              <span className="pill ok">
                <Icon name="check" size={13} /> yes, to the paise
              </span>
            ) : (
              <span className="pill bad">
                <Icon name="x" size={13} /> NO
              </span>
            )}
          </div>
          <DataTable
            columns={['Source', 'Matched', 'In an exception', 'Ignored', 'Total']}
            numeric={[1, 2, 3, 4]}
            rows={o.coverage.map((c) => [
              sourceName(c.type),
              inr(c.amountPaise.matched),
              inr(c.amountPaise.inException),
              inr(c.amountPaise.ignored),
              `${inr(c.amountPaise.total)} ${c.reconciles ? '✓' : '✗'}`,
            ])}
          />
          <div className="source-strip">
            <span>
              Ledger <b>{inr(s.ledger.amountPaise)}</b> ({s.ledger.records})
            </span>
            <span>
              Payments captured <b>{inr(s.payments.capturedPaise)}</b> ({s.payments.captured} of{' '}
              {s.payments.records})
            </span>
            <span>
              Fees incl. GST <b>{inr(s.payments.feesPaise)}</b>
            </span>
            <span>
              Refunds <b>{inr(s.refunds.amountPaise)}</b> ({s.refunds.records})
            </span>
            <span>
              Settlements <b>{inr(s.settlements.amountPaise)}</b> ({s.settlements.records})
            </span>
            <span>
              Bank credits <b>{inr(s.bank.credits.amountPaise)}</b> ({s.bank.credits.records})
            </span>
            <span>
              Bank debits <b>{inr(s.bank.debits.amountPaise)}</b> ({s.bank.debits.records})
            </span>
          </div>
        </section>
      </Reveal>

      <Reveal className="span-2">
        <section className="card books">
          <span className="ico">
            <Icon name="book" size={22} />
          </span>
          <div>
            <h3 className="card-title">Books</h3>
            <p className="muted">
              {o.journal.settlementsBooked} settlements are booked as {o.journal.vouchers} vouchers
              {o.journal.adjustmentsBooked > 0
                ? `, including ${o.journal.adjustmentsBooked} adjustments a person approved`
                : ''}
              . {o.journal.settlementsNotBooked.count} ({inr(o.journal.settlementsNotBooked.paise)})
              cannot be booked yet: no bank credit has been matched to them.
            </p>
          </div>
          <a className="button primary" href={linkTo(runId, 'downloads')}>
            <Icon name="download" size={16} /> Download the vouchers
          </a>
        </section>
      </Reveal>
    </div>
  );
}

function Fact({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>
        <Icon name={icon} size={16} /> {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---------- downloads ----------

const FILES: { name: string; title: string; text: string; kind: string }[] = [
  {
    name: 'report.json',
    title: 'Run report',
    kind: 'JSON',
    text: 'Everything on the summary, every exception and every voucher, in integer paise.',
  },
  {
    name: 'report.csv',
    title: 'Run report',
    kind: 'CSV',
    text: 'The summary as rows a spreadsheet can read.',
  },
  {
    name: 'exceptions.csv',
    title: 'Exceptions',
    kind: 'CSV',
    text: 'One row per exception with its age, the suggested action, the next step, the checker’s verdict and any decision.',
  },
  {
    name: 'journal-entries.csv',
    title: 'Journal entries',
    kind: 'CSV',
    text: 'Vouchers for the books: date, voucher type, debit ledger, credit ledger, amount, narration with record ids. Fees, GST on fees, refunds and chargebacks.',
  },
  {
    name: 'journal-lines.csv',
    title: 'Journal lines for Tally',
    kind: 'CSV',
    text: 'The same vouchers, one row per ledger line, the layout TallyPrime’s Import Data from Excel maps. Open in Excel and save as .xlsx first.',
  },
];

function Downloads({ runId }: { runId: string }) {
  return (
    <section>
      <div className="section-head">
        <h2>Downloads</h2>
        <p className="muted">
          Every file is generated from this run, so it matches the screen to the paisa.
        </p>
      </div>
      <div className="downloads">
        {FILES.map((f, i) => (
          <Reveal key={f.name} i={i % 3}>
            <div className="card download lift">
              <span className="ico file">
                <Icon name="file" size={22} />
                <i>{f.kind}</i>
              </span>
              <div className="download-body">
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
              <a className="button sm" href={`/runs/${runId}/${f.name}`} download>
                <Icon name="download" size={15} /> Download
              </a>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
