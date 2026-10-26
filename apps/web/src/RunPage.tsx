import { useEffect, useState } from 'react';
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
import { settledBy } from './metrics';
import { type MoneyState, STATE } from './states';
import { Banner, Count, CountPaise, Reveal } from './ui';

type RunRoute = Extract<Route, { page: 'run' }>;

const TAB_NAMES: Record<Tab, string> = {
  summary: 'Summary',
  exceptions: 'Exceptions',
  audit: 'Audit',
  downloads: 'Downloads',
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
      <div className="skel" style={{ height: 36, width: 280, marginBottom: 18 }} />
      <div className="skel" style={{ height: 140, marginBottom: 16 }} />
      <div className="skel" style={{ height: 220 }} />
    </div>
  );
}

// ---------- while the run is working ----------

const STAGES = [
  {
    stage: 'matching',
    icon: 'code',
    title: 'Rules match',
    text: 'What can be proved, to the paisa',
  },
  {
    stage: 'investigating',
    icon: 'bot',
    title: 'Agent investigates',
    text: 'The leftovers, each claim re-checked',
  },
  { stage: 'ready', icon: 'check', title: 'Ready to review', text: 'Exceptions and audit trail' },
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
          <p className="muted">Usually a couple of seconds.</p>
        </div>
      </div>
      <ol className="pipeline">
        {STAGES.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'now' : 'todo';
          return (
            <li key={s.stage} className={state}>
              <span className="node">
                {state === 'done' ? (
                  <Icon name="check" size={16} />
                ) : (
                  <Icon name={s.icon} size={16} />
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
              {p.counts.proposals} of {p.expected} investigated
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
      <p className="working-counts">
        {p.counts.groups} groups proved · {p.counts.exceptions} exceptions · {p.counts.refused}{' '}
        refused by the checker
      </p>
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
        {busy ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
        {busy ? 'Resetting…' : 'Reset demo'}
      </button>
      {problem ? <span className="bad-text"> {problem}</span> : null}
    </div>
  );
}

function RunHeader({ o, runId }: { o: Overview; runId: string }) {
  const agent = o.llm.agent === 'scripted' ? 'Scripted agent' : (o.llm.agent ?? 'No agent');
  return (
    <header className="run-head">
      <div>
        <h1>{o.run.preset === 'eval' ? '500-order reconciliation' : '50-order reconciliation'}</h1>
        <p className="meta">
          As of {o.run.asOf} · {agent}
          {o.llm.calls > 0 ? ` · ${o.llm.calls} model calls, ${dollars(o.llm.costUsd)}` : ''}
          {o.time.seconds === null ? '' : ` · ${o.time.seconds} s`} ·{' '}
          {o.reconciles ? (
            <span className="ok-text">
              <Icon name="check" size={13} /> Totals add up
            </span>
          ) : (
            <span className="bad-text">Totals do NOT add up</span>
          )}
        </p>
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
          <b>Replay.</b> A recorded run, read-only. <a href="#/">Start your own</a> to approve or
          reject.
        </Banner>
      ) : null}
      {o.run.archived ? (
        <Banner tone="warn">
          <b>Archived.</b> Put away by Reset demo: readable, but no longer reviewable.{' '}
          <a href="#/">Start a new run</a>.
        </Banner>
      ) : null}
      {o.run.partial ? (
        <Banner tone="warn" role="alert">
          <b>Partial run.</b> Razorpay did not return everything:
          <ul>
            {o.run.gaps.map((g, i) => (
              <li key={i}>{g.detail}</li>
            ))}
          </ul>
          Some exceptions may come from the gap, not a real difference. Import again to fill it in.
        </Banner>
      ) : null}
      {o.failures.note ? (
        <Banner tone="warn">{o.failures.note}. The exceptions it left are still open.</Banner>
      ) : null}
      {o.failures.injected ? (
        <Banner>
          <b>Chaos is on.</b> Three investigations were broken on purpose: a timeout, no quota left,
          and a reply cut off mid-JSON. {handled ?? ''} The run still finished, and all three went
          to a person with the reason (see the filter “Handed to a person by the system” in{' '}
          <a href={linkTo(runId, 'exceptions')}>Exceptions</a>).
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

/** A segment or bar in a money state: the palette's colour and ink, and its label unless one is given. */
const inState = (state: MoneyState, label: string = STATE[state].label) => ({
  label,
  color: STATE[state].color,
  ink: STATE[state].ink,
});
/** A legend entry for a money state: colour, icon and words, so colour never carries the meaning alone. */
const legendFor = (state: MoneyState, label: string = STATE[state].label, value?: string) => ({
  key: state,
  label,
  color: STATE[state].color,
  icon: STATE[state].icon,
  ...(value === undefined ? {} : { value }),
});

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
  const excTotal = sum(reasons.map((r) => r.total));
  const settled = settledBy(o);

  const gapRow: StackRow = {
    id: 'gap',
    label: '',
    segments: [
      {
        key: 'explained',
        ...inState(settled.state, settled.label),
        value: toBig(gap.explainedPaise),
        shown: inr(gap.explainedPaise),
      },
      {
        key: 'waiting',
        ...inState('wait'),
        value: toBig(gap.awaitingPaise),
        shown: inr(gap.awaitingPaise),
      },
      {
        key: 'open',
        ...inState('open'),
        value: toBig(gap.openPaise),
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
        ...inState('rules', 'Matched'),
        value: BigInt(c.matched),
        detail: inr(c.amountPaise.matched),
      },
      {
        key: 'exception',
        ...inState('open', 'In an exception'),
        value: BigInt(c.inException),
        detail: inr(c.amountPaise.inException),
      },
      {
        key: 'ignored',
        ...inState('ignored'),
        value: BigInt(c.ignored),
        detail: inr(c.amountPaise.ignored),
      },
    ],
  }));

  const reasonRows: StackRow[] = reasons.map((r) => ({
    id: r.reasonCode,
    label: sentence(r.reasonCode),
    href: linkTo(runId, 'exceptions'),
    totalLabel: `${r.total}`,
    segments: [
      { key: 'resolved', ...inState(settled.state, settled.label), value: BigInt(r.resolved) },
      { key: 'waiting', ...inState('wait'), value: BigInt(r.proposed) },
      { key: 'open', ...inState('open'), value: BigInt(r.open) },
      { key: 'dismissed', ...inState('ignored', 'Dismissed'), value: BigInt(r.dismissed) },
    ],
  }));

  const ageItems: BarItem[] = o.openExceptions.byAge.map((b) => ({
    id: b.bucket,
    label: b.bucket,
    value: toBig(b.stakePaise),
    display: `${b.cases} · ${inr(b.stakePaise)}`,
    color: STATE.open.color,
  }));

  const methodItems: BarItem[] = o.leakage.byMethod.map((m) => ({
    id: m.method,
    label: methodName(m.method),
    value: toBig(m.excessPaise),
    display: inr(m.excessPaise),
    color: 'var(--kind-fee)',
  }));

  const tierItems: BarItem[] = o.matching.byTier.map((t, i) => ({
    id: t.label,
    label: t.label,
    sub: `${t.groups} groups`,
    value: BigInt(t.records),
    display: `${t.records} records · ${percent(t.share)}`,
    color: `var(--ord-${Math.min(i + 1, 4)})`,
  }));

  const r = o.resolution;
  const settledItems: BarItem[] = (
    [
      ['rules', 'Rule groups, proved by code', r.ruleGroups, 'rules'],
      ['agent-match', 'Agent match, approved by you', r.agentMatchesApprovedByPerson, 'you'],
      [
        'agent-explain',
        'Agent explanation, approved by you',
        r.agentExplanationsApprovedByPerson,
        'you',
      ],
      ['auto', 'Verified AI proposal, auto-accepted', r.autoAccepted, 'ai'],
      ['rejected', 'Proposal rejected by you (open again)', r.rejectedByPerson, 'open'],
      ['waiting', 'Waiting for you', r.waiting, 'wait'],
    ] as const
  ).map(([id, label, n, state]) => ({
    id,
    label,
    value: BigInt(n),
    display: String(n),
    color: STATE[state].color,
  }));

  return (
    <div className="dash">
      <Reveal>
        <div className="hero-row">
          <section className="card gap-card">
            <span className="kicker">Still unreconciled</span>
            <div className="gap-figure">
              <CountPaise paise={gap.gapPaise} />
            </div>
            <StackedBars rows={[gapRow]} tall />
            <Legend
              items={[
                legendFor(settled.state, settled.label, inr(gap.explainedPaise)),
                legendFor('wait', undefined, inr(gap.awaitingPaise)),
                legendFor('open', undefined, inr(gap.openPaise)),
              ]}
            />
          </section>
          <section className="card ring-card">
            <RingMeter
              value={ledger?.matchRate ?? 0}
              label="Orders matched"
              sub={
                ledger ? `${ledger.matched} of ${ledger.matched + ledger.inException}` : undefined
              }
            />
            <div className="ring-facts">
              <span>
                <b>
                  <Count value={o.resolution.ruleGroups} />
                </b>
                groups proved
              </span>
              <span>
                <b>
                  <Count value={excTotal} />
                </b>
                exceptions
              </span>
            </div>
          </section>
        </div>
      </Reveal>

      <div className="grid-2">
        <Reveal>
          <ChartCard
            title="Coverage by source"
            subtitle="Where every record ended up."
            legend={
              <Legend
                items={[
                  legendFor('rules', 'Matched'),
                  legendFor('open', 'In an exception'),
                  legendFor('ignored'),
                ]}
              />
            }
            table={{
              columns: ['Source', 'Matched', 'In exception', 'Ignored', 'Rate'],
              numeric: [1, 2, 3, 4],
              rows: o.coverage.map((c) => [
                sourceName(c.type),
                String(c.matched),
                String(c.inException),
                String(c.ignored),
                percent(c.matchRate),
              ]),
            }}
            foot="Ignored: records no rule should match."
          >
            <StackedBars rows={coverageRows} />
          </ChartCard>
        </Reveal>
        <Reveal i={1}>
          <ChartCard
            title="Exceptions by reason"
            subtitle="Where the rules stopped."
            legend={
              <Legend
                items={[
                  legendFor(settled.state, settled.label),
                  legendFor('wait'),
                  legendFor('open'),
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
            foot={<a href={linkTo(runId, 'exceptions')}>Review the exceptions →</a>}
          >
            {reasonRows.length > 0 ? (
              <StackedBars rows={reasonRows} />
            ) : (
              <p className="empty">
                <Icon name="check" size={16} /> No exceptions.
              </p>
            )}
          </ChartCard>
        </Reveal>
      </div>

      <div className="grid-3">
        <Reveal>
          <ChartCard
            title="Unsettled by age"
            subtitle={`Cases and rupees, as of ${o.openExceptions.asOf}`}
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
                <Icon name="check" size={16} /> Nothing unsettled.
              </p>
            )}
          </ChartCard>
        </Reveal>
        <Reveal i={1}>
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Fee leakage</h3>
              <p className="card-sub">Charged above your fee contract</p>
            </div>
            <div className="figure">
              <CountPaise paise={o.leakage.excessPaise} />
            </div>
            <p className="figure-sub">
              {o.leakage.overchargedCount} of {o.leakage.assessed} payments overcharged
            </p>
            {methodItems.length > 0 ? <BarList items={methodItems} /> : null}
          </section>
        </Reveal>
        <Reveal i={2}>
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Delayed payouts</h3>
              <p className="card-sub">Paid out later than the normal lag</p>
            </div>
            <div className="figure">
              <Count value={o.delays.delayedCount} />
            </div>
            <p className="figure-sub">
              {inr(o.delays.delayedPaise)} paid late
              {o.delays.overdueCount > 0
                ? ` · ${o.delays.overdueCount} overdue (${inr(o.delays.overduePaise)})`
                : ' · none overdue'}
            </p>
            {o.delays.delayed.length > 0 ? (
              <ul className="mini-rows">
                {o.delays.delayed.slice(0, 3).map((d) => (
                  <li key={d.rzpId}>
                    <span>{d.rzpId}</span>
                    <b>{d.createdLate ? `${d.businessDaysLate} days late` : 'credit late'}</b>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </Reveal>
      </div>

      <Reveal>
        <details className="card more">
          <summary>
            More detail <span>rule tiers, who settled what, tables, totals</span>
          </summary>
          <div className="more-body">
            <div className="more-block">
              <h4>How the rules matched (strictest first)</h4>
              <BarList items={tierItems} />
            </div>
            <div className="more-block">
              <h4>How things were settled</h4>
              <BarList items={settledItems} />
            </div>
            {o.leakage.worst.length > 0 ? (
              <div className="more-block">
                <h4>Largest fee overcharges</h4>
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
                <p className="source-strip">
                  Base fee {inr(o.leakage.excessBasePaise)} plus GST {inr(o.leakage.excessGstPaise)}
                  {o.leakage.contract.source === 'default'
                    ? '. No fee contract was stored, so the default was used.'
                    : '.'}
                  {o.leakage.notAssessable > 0
                    ? ` ${o.leakage.notAssessable} payments could not be judged.`
                    : ''}
                  {o.leakage.undercharged.count > 0
                    ? ` ${o.leakage.undercharged.count} were charged ${inr(o.leakage.undercharged.shortfallPaise)} below the contract (not netted).`
                    : ''}
                </p>
              </div>
            ) : null}
            {o.delays.delayed.length > 0 ? (
              <div className="more-block">
                <h4>Delayed settlements</h4>
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
              </div>
            ) : null}
            <div className="more-block">
              <h4>
                Do the totals add up?{' '}
                {o.reconciles ? (
                  <span className="pill ok">
                    <Icon name="check" size={12} /> yes, to the paise
                  </span>
                ) : (
                  <span className="pill bad">
                    <Icon name="x" size={12} /> NO
                  </span>
                )}
              </h4>
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
                  Ledger <b>{inr(s.ledger.amountPaise)}</b>
                </span>
                <span>
                  Payments captured <b>{inr(s.payments.capturedPaise)}</b>
                </span>
                <span>
                  Fees incl. GST <b>{inr(s.payments.feesPaise)}</b>
                </span>
                <span>
                  Refunds <b>{inr(s.refunds.amountPaise)}</b>
                </span>
                <span>
                  Settlements <b>{inr(s.settlements.amountPaise)}</b>
                </span>
                <span>
                  Bank credits <b>{inr(s.bank.credits.amountPaise)}</b>
                </span>
                <span>
                  Bank debits <b>{inr(s.bank.debits.amountPaise)}</b>
                </span>
              </div>
            </div>
          </div>
        </details>
      </Reveal>

      <Reveal>
        <div className="books-bar">
          <span>
            <b>Books:</b> {o.journal.settlementsBooked} settlements booked as {o.journal.vouchers}{' '}
            vouchers
            {o.journal.settlementsNotBooked.count > 0
              ? `; ${o.journal.settlementsNotBooked.count} (${inr(o.journal.settlementsNotBooked.paise)}) not bookable yet, with no bank credit matched.`
              : '.'}
          </span>
          <a className="button sm" href={linkTo(runId, 'downloads')}>
            <Icon name="download" size={14} /> Vouchers and reports
          </a>
        </div>
      </Reveal>
    </div>
  );
}

// ---------- downloads ----------

const FILES: { name: string; title: string; text: string; kind: string }[] = [
  {
    name: 'report.json',
    title: 'Run report',
    kind: 'JSON',
    text: 'Everything on the summary, every exception and voucher, in integer paise.',
  },
  {
    name: 'report.csv',
    title: 'Run report',
    kind: 'CSV',
    text: 'The summary as spreadsheet rows.',
  },
  {
    name: 'exceptions.csv',
    title: 'Exceptions',
    kind: 'CSV',
    text: 'One row per exception: age, next step, checker verdict and any decision.',
  },
  {
    name: 'journal-entries.csv',
    title: 'Journal entries',
    kind: 'CSV',
    text: 'Vouchers for the books: fees, GST, refunds and chargebacks.',
  },
  {
    name: 'journal-lines.csv',
    title: 'Journal lines for Tally',
    kind: 'CSV',
    text: 'The same vouchers, one row per ledger line. Save as .xlsx before TallyPrime’s import.',
  },
];

function Downloads({ runId }: { runId: string }) {
  return (
    <section>
      <div className="section-head">
        <h2>Downloads</h2>
      </div>
      <div className="card dl-list">
        {FILES.map((f) => (
          <div key={f.name} className="dl-row">
            <span className="ico dl-ico">
              <Icon name="file" size={18} />
              <i>{f.kind}</i>
            </span>
            <div>
              <b>{f.title}</b>
              <span>{f.text}</span>
            </div>
            <a className="button sm" href={`/runs/${runId}/${f.name}`} download>
              <Icon name="download" size={14} /> Download
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
