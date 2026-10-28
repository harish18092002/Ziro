import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, get, type Overview, type Progress, post } from './api';
import { AuditTab } from './Audit';
import { ratio, toBig } from './chart-math';
import {
  type BarItem,
  BarList,
  ChartCard,
  DataTable,
  Legend,
  RingMeter,
  type StackRow,
  StackedBars,
  Meter,
} from './Charts';
import { ExceptionsTab } from './Exceptions';
import {
  dollars,
  exceptionsLink,
  failureSentence,
  inr,
  linkTo,
  percent,
  range,
  type Route,
  sentence,
  type Tab,
  words,
} from './format';
import { useInView, useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { settledBy } from './metrics';
import { MOTION } from './motion';
import { Reports } from './Reports';
import { ACTOR, type Actor, type MoneyState, STATE } from './states';
import { Banner, Count, CountDownPaise, CountPaise, Reveal } from './ui';

type RunRoute = Extract<Route, { page: 'run' }>;

const TAB_NAMES: Record<Tab, string> = {
  summary: 'Overview',
  exceptions: 'Exceptions',
  audit: 'Audit trail',
  downloads: 'Reports',
};

export function RunPage({ route }: { route: RunRoute }) {
  const progress = useProgress(route.runId);
  // One overview for the banners, the header, the tab badges and every tab that reads totals.
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
  const o = overview.data;
  const needYou = o ? needsYou(o) : null;

  return (
    <div className="run page">
      {o ? <RunHeader o={o} runId={route.runId} /> : <div className="skel head-skel" />}
      {o ? <RunBanners o={o} runId={route.runId} /> : null}
      <Tabs runId={route.runId} tab={route.tab} needYou={needYou} />
      <div className="tab-body" key={route.tab}>
        {route.tab === 'summary' && (
          <Summary runId={route.runId} o={o} p={progress} error={overview.error} />
        )}
        {route.tab === 'exceptions' && (
          <ExceptionsTab
            runId={route.runId}
            selected={route.itemId}
            overview={o}
            initial={route.query ?? null}
            onDecided={overview.reload}
            readOnly={o !== null && (o.run.featured !== null || o.run.archived)}
          />
        )}
        {route.tab === 'audit' && <AuditTab runId={route.runId} selected={route.itemId} />}
        {route.tab === 'downloads' && <Reports runId={route.runId} o={o} />}
      </div>
    </div>
  );
}

const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);
/** Exceptions a person still has to act on: open, or a verified proposal waiting for a decision. */
const needsYou = (o: Overview): number => sum(o.exceptionsByReason.map((x) => x.open + x.proposed));

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

/** The four places in a run, in the order you use them, with one underline that slides (a transform). */
function Tabs({ runId, tab, needYou }: { runId: string; tab: Tab; needYou: number | null }) {
  const nav = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const on = nav.current?.querySelector<HTMLElement>('a.on');
      if (on) setBar({ x: on.offsetLeft, w: on.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tab, needYou]);
  return (
    <nav ref={nav} className="tabs" aria-label="Run sections">
      {(Object.keys(TAB_NAMES) as Tab[]).map((t, i) => (
        <a
          key={t}
          href={linkTo(runId, t)}
          className={t === tab ? 'on' : ''}
          aria-current={t === tab ? 'page' : undefined}
        >
          <span className="tab-n">{String(i + 1).padStart(2, '0')}</span>
          {TAB_NAMES[t]}
          {t === 'exceptions' && needYou !== null && needYou > 0 ? (
            <span className="tab-badge" aria-label={`${needYou} need you`}>
              {needYou}
            </span>
          ) : null}
        </a>
      ))}
      <span
        className="tab-ink"
        aria-hidden="true"
        style={bar ? { transform: `translateX(${bar.x}px) scaleX(${bar.w})` } : { opacity: 0 }}
      />
    </nav>
  );
}

/** The dashboard's shape while it loads, so nothing jumps when the numbers arrive. */
function RunSkeleton() {
  return (
    <div className="dash" aria-busy="true" aria-label="Loading the run">
      <div className="skel head-skel" />
      <div className="health">
        <div className="skel skel-card tall" />
        <div className="skel skel-card tall" />
      </div>
      <div className="skel skel-card" />
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

/** Only what the server reports: the stage it is in, and the counts it has so far. */
function Working({ p }: { p: Progress }) {
  const at = STAGES.findIndex((s) => s.stage === p.stage);
  const share = p.expected ? Math.min(1, p.counts.proposals / p.expected) : 0;
  return (
    <section className="working page" aria-live="polite">
      <span className="slash">Working on your batch</span>
      <h1 className="serif">
        Reconciling <em>now.</em>
      </h1>
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
        <span>
          <b>{p.counts.groups}</b> groups proved
        </span>
        <span>
          <b>{p.counts.exceptions}</b> exceptions
        </span>
        <span>
          <b>{p.counts.refused}</b> refused by the checker
        </span>
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

function runTitle(o: Overview): { title: string; source: string } {
  if (o.run.preset === 'eval')
    return { title: '500-order reconciliation', source: 'Synthetic data' };
  if (o.run.preset !== null)
    return { title: `${o.sources.ledger.records}-order reconciliation`, source: 'Synthetic data' };
  return { title: 'Test-account reconciliation', source: 'Razorpay test mode' };
}

function RunHeader({ o, runId }: { o: Overview; runId: string }) {
  const agent = o.llm.agent === 'scripted' ? 'Scripted agent' : (o.llm.agent ?? 'No agent');
  const { title, source } = runTitle(o);
  return (
    <header className="run-head">
      <div>
        <span className="slash">
          {source}
          {o.run.featured !== null ? ' · recorded replay' : ''}
        </span>
        <h1 className="serif">{title}</h1>
        <ul className="meta-chips">
          <li>
            <Icon name="clock" size={13} /> As of {o.run.asOf}
          </li>
          <li>
            <Icon name={o.llm.agent === 'scripted' ? 'code' : 'bot'} size={13} /> {agent}
            {o.llm.calls > 0 ? ` · ${o.llm.calls} model calls, ${dollars(o.llm.costUsd)}` : ''}
          </li>
          {o.time.seconds === null ? null : (
            <li>
              <Icon name="bolt" size={13} /> {o.time.seconds} s
            </li>
          )}
          <li className={o.reconciles ? 'ok' : 'bad'}>
            <Icon name={o.reconciles ? 'check' : 'x'} size={13} />
            {o.reconciles ? 'Totals tie out to the paisa' : 'Totals do NOT add up'}
          </li>
        </ul>
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
          to a person with the reason (see{' '}
          <a href={exceptionsLink(runId, { filter: 'degraded' })}>handed to a person</a>).
        </Banner>
      ) : handled ? (
        <Banner>{handled}</Banner>
      ) : null}
    </div>
  );
}

// ---------- overview dashboard ----------

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

function Summary({
  runId,
  o,
  p,
  error,
}: {
  runId: string;
  o: Overview | null;
  p: Progress;
  error: string | null;
}) {
  if (error)
    return (
      <Banner tone="bad" role="alert">
        {error}
      </Banner>
    );
  if (o === null) return <RunSkeleton />;

  const ledger = o.coverage.find((c) => c.type === 'ledger_entry');
  const reasons = o.exceptionsByReason;
  const excTotal = sum(reasons.map((r) => r.total));
  const settled = settledBy(o);
  const has = (pick: (x: (typeof reasons)[number]) => number) => sum(reasons.map(pick)) > 0;

  const reasonRows: StackRow[] = reasons.map((r) => ({
    id: r.reasonCode,
    label: sentence(r.reasonCode),
    href: exceptionsLink(runId, { reason: r.reasonCode }),
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
    label: range(b.bucket),
    value: toBig(b.stakePaise),
    display: `${b.cases} · ${inr(b.stakePaise)}`,
    color: STATE.open.color,
  }));

  return (
    <div className="dash">
      <Reveal>
        <div className="health">
          <GapJourney o={o} runId={runId} needYou={needsYou(o)} />
          <section className="card ring-card">
            <span className="kicker">Orders reconciled</span>
            <RingMeter
              value={ledger?.matchRate ?? 0}
              label="Orders matched, by rules or approved"
              sub={ledger ? `${ledger.matched} of ${ledger.total}` : undefined}
            />
            <dl className="ring-facts">
              <div>
                <dt>Groups proved by code</dt>
                <dd>
                  <Count value={o.resolution.ruleGroups} />
                </dd>
              </div>
              <div>
                <dt>Exceptions raised</dt>
                <dd>
                  <Count value={excTotal} />
                </dd>
              </div>
              <div>
                <dt>Fee overcharged</dt>
                <dd>
                  <CountPaise paise={o.leakage.excessPaise} />
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </Reveal>

      <Reveal>
        <RunFlow o={o} p={p} runId={runId} />
      </Reveal>

      <div className="grid-2">
        <Reveal>
          <ChartCard
            title="Why the rules stopped"
            subtitle="Exceptions by reason, and where each stands. Pick a reason to review it."
            legend={
              <Legend
                items={[
                  ...(has((x) => x.resolved) ? [legendFor(settled.state, settled.label)] : []),
                  ...(has((x) => x.proposed) ? [legendFor('wait')] : []),
                  ...(has((x) => x.open) ? [legendFor('open')] : []),
                  ...(has((x) => x.dismissed) ? [legendFor('ignored', 'Dismissed')] : []),
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
        <Reveal i={1}>
          <ChartCard
            title="Unsettled, by age"
            subtitle={`How long unsettled money has waited, as of ${o.openExceptions.asOf}. Start with the oldest.`}
            table={{
              columns: ['Age', 'Cases', 'At stake'],
              numeric: [1, 2],
              rows: o.openExceptions.byAge.map((b) => [
                range(b.bucket),
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
      </div>

      <section className="issues" aria-label="Money worth raising with Razorpay">
        <Reveal>
          <LeakageCard o={o} />
        </Reveal>
        <Reveal i={1}>
          <DelaysCard o={o} />
        </Reveal>
      </section>

      <Reveal>
        <DetailTabs o={o} />
      </Reveal>

      <Reveal>
        <a className="books-bar" href={linkTo(runId, 'downloads')}>
          <span className="books-ico">
            <Icon name="book" size={18} />
          </span>
          <span>
            <b>Books ready:</b> {o.journal.settlementsBooked} settlements as {o.journal.vouchers}{' '}
            Tally vouchers
            {o.journal.settlementsNotBooked.count > 0
              ? `; ${o.journal.settlementsNotBooked.count} (${inr(o.journal.settlementsNotBooked.paise)}) not bookable yet, with no bank credit matched.`
              : '.'}
          </span>
          <span className="books-go">
            Reports and exports <Icon name="arrow" size={14} />
          </span>
        </a>
      </Reveal>
    </div>
  );
}

/**
 * The run as it actually flowed, left to right: what came in, what the rules proved, what they left, what the agent
 * proposed, what the checker let through, and what a person decided. Every count is the server's.
 */
function RunFlow({ o, p, runId }: { o: Overview; p: Progress; runId: string }) {
  const records = sum(o.coverage.map((c) => c.total));
  const exceptions = sum(o.exceptionsByReason.map((r) => r.total));
  const approved =
    o.resolution.agentMatchesApprovedByPerson + o.resolution.agentExplanationsApprovedByPerson;
  const steps: {
    actor: Actor;
    icon: IconName;
    figure: number;
    label: string;
    sub: string;
    href?: string;
  }[] = [
    {
      actor: 'code',
      icon: 'upload',
      figure: records,
      label: 'records in',
      sub: `${o.sources.ledger.records} orders, ${o.sources.payments.records} payments, ${o.sources.bank.credits.records + o.sources.bank.debits.records} bank lines`,
    },
    {
      actor: 'code',
      icon: 'code',
      figure: o.resolution.ruleGroups,
      label: 'groups proved by rules',
      sub: `${o.matching.matchedRecords} records, no AI`,
    },
    {
      actor: 'code',
      icon: 'search',
      figure: exceptions,
      label: 'exceptions',
      sub: 'ambiguous or unexplained',
      href: linkTo(runId, 'exceptions'),
    },
    {
      actor: 'ai',
      icon: 'bot',
      figure: p.counts.proposals,
      label: 'agent proposals',
      sub: p.agent === 'scripted' ? 'scripted stand-in, no model' : 'read-only investigation',
    },
    {
      actor: 'code',
      icon: 'shield',
      figure: p.counts.verified,
      label: 'matches verified by the checker',
      sub: `${p.counts.refused} refused · ${Math.max(0, p.counts.proposals - p.counts.verified - p.counts.refused)} claimed no match`,
      href: exceptionsLink(runId, { filter: 'refused' }),
    },
    {
      actor: 'you',
      icon: 'user',
      figure: o.resolution.waiting,
      label: 'waiting for you',
      sub: `${approved} approved${o.resolution.autoAccepted > 0 ? `, ${o.resolution.autoAccepted} auto-accepted` : ''}`,
      href: exceptionsLink(runId, { filter: 'waiting' }),
    },
  ];
  return (
    <section className="card run-flow" aria-label="How this run flowed">
      <div className="card-head">
        <h3 className="card-title">How this run flowed</h3>
        <p className="card-sub">
          Code proves, the AI proposes, the checker verifies, you decide. Counts from this run.
        </p>
      </div>
      <ol className="flow-steps">
        {steps.map((s, i) => {
          const body = (
            <>
              <span className="fs-ico">
                <Icon name={s.icon} size={16} />
              </span>
              <b className="fs-figure">
                <Count value={s.figure} />
              </b>
              <span className="fs-label">{s.label}</span>
              <span className="fs-sub">{s.sub}</span>
            </>
          );
          return (
            <li
              key={s.label}
              style={{
                ['--actor' as string]: ACTOR[s.actor].color,
                ['--i' as string]: i,
              }}
            >
              {s.href ? (
                <a className="fs-step" href={s.href}>
                  {body}
                </a>
              ) : (
                <div className="fs-step">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LeakageCard({ o }: { o: Overview }) {
  const l = o.leakage;
  const items: BarItem[] = l.byMethod.map((m) => ({
    id: m.method,
    label: methodName(m.method),
    value: toBig(m.excessPaise),
    display: inr(m.excessPaise),
    color: 'var(--kind-fee)',
  }));
  return (
    <section className="card issue">
      <header>
        <span className="issue-ico fee">
          <Icon name="trend" size={18} />
        </span>
        <div>
          <h3 className="card-title">Fee leakage</h3>
          <p className="card-sub">Fees charged above your contract. Worth raising with Razorpay.</p>
        </div>
      </header>
      <div className="figure">
        <CountPaise paise={l.excessPaise} />
      </div>
      <p className="figure-sub">
        {l.overchargedCount} of {l.assessed} payments overcharged · base {inr(l.excessBasePaise)} +
        GST {inr(l.excessGstPaise)}
      </p>
      {items.length > 0 ? <BarList items={items} /> : null}
      {l.worst.length > 0 ? (
        <details className="fold-table">
          <summary>
            Largest overcharges <Icon name="arrow" size={13} />
          </summary>
          <DataTable
            columns={['Payment', 'Method', 'Expected', 'Charged', 'Excess']}
            numeric={[2, 3, 4]}
            rows={l.worst
              .slice(0, 5)
              .map((w) => [
                w.rzpId,
                methodName(w.method),
                inr(w.expectedFeePaise),
                inr(w.actualFeePaise),
                inr(w.excessPaise),
              ])}
          />
        </details>
      ) : null}
      <p className="fine-print">
        {l.contract.source === 'default'
          ? 'No fee contract was stored, so the default was used. '
          : ''}
        {l.notAssessable > 0 ? `${l.notAssessable} payments could not be judged. ` : ''}
        {l.undercharged.count > 0
          ? `${l.undercharged.count} were charged ${inr(l.undercharged.shortfallPaise)} below the contract (never netted).`
          : ''}
      </p>
    </section>
  );
}

function DelaysCard({ o }: { o: Overview }) {
  const d = o.delays;
  return (
    <section className="card issue">
      <header>
        <span className="issue-ico late">
          <Icon name="clock" size={18} />
        </span>
        <div>
          <h3 className="card-title">Delayed payouts</h3>
          <p className="card-sub">Payouts later than the usual T+2. Check them with Razorpay.</p>
        </div>
      </header>
      <div className="figure">
        <Count value={d.delayedCount} />
        <small> late</small>
      </div>
      <p className="figure-sub">
        {inr(d.delayedPaise)} paid late
        {d.overdueCount > 0
          ? ` · ${d.overdueCount} overdue (${inr(d.overduePaise)})`
          : ' · none overdue'}
      </p>
      {d.delayed.length > 0 ? (
        <ul className="mini-rows">
          {d.delayed.slice(0, 3).map((x) => (
            <li key={x.rzpId}>
              <code>{x.rzpId}</code>
              <b>{x.createdLate ? `${x.businessDaysLate} business days late` : 'credit late'}</b>
            </li>
          ))}
        </ul>
      ) : null}
      {d.delayed.length > 0 ? (
        <details className="fold-table">
          <summary>
            All delayed settlements <Icon name="arrow" size={13} />
          </summary>
          <DataTable
            columns={['Settlement', 'Due', 'Created', 'Days late', 'Amount']}
            numeric={[3, 4]}
            rows={d.delayed.map((x) => [
              x.rzpId,
              x.dueDate ?? '–',
              x.settlementDate,
              x.createdLate ? String(x.businessDaysLate) : 'credit late',
              inr(x.amountPaise),
            ])}
          />
        </details>
      ) : null}
    </section>
  );
}

type Detail = 'coverage' | 'tiers' | 'settled' | 'tieout';
const DETAIL_NAMES: Record<Detail, string> = {
  coverage: 'Coverage by source',
  tiers: 'Rule tiers',
  settled: 'Who settled what',
  tieout: 'Totals tie-out',
};

/** The secondary detail behind one segmented control, instead of one long fold. */
function DetailTabs({ o }: { o: Overview }) {
  const [view, setView] = useState<Detail>('coverage');
  const s = o.sources;
  const r = o.resolution;

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
  const tierItems: BarItem[] = o.matching.byTier.map((t, i) => ({
    id: t.label,
    label: t.label,
    sub: `${t.groups} groups`,
    value: BigInt(t.records),
    display: `${t.records} records · ${percent(t.share)}`,
    color: `var(--ord-${Math.min(i + 1, 4)})`,
  }));
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

  const body: Record<Detail, ReactNode> = {
    coverage: (
      <>
        <Legend
          items={[
            legendFor('rules', 'Matched'),
            ...(o.coverage.some((c) => c.inException > 0)
              ? [legendFor('open', 'In an exception')]
              : []),
            ...(o.coverage.some((c) => c.ignored > 0) ? [legendFor('ignored')] : []),
          ]}
        />
        <StackedBars rows={coverageRows} />
        <p className="fine-print">
          Ignored: records no rule should match, such as bank lines that are not Razorpay payouts.
        </p>
      </>
    ),
    tiers: (
      <>
        <p className="card-sub">Strictest first. Each tier only takes what the one above left.</p>
        <BarList items={tierItems} />
      </>
    ),
    settled: <BarList items={settledItems} />,
    tieout: (
      <>
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
      </>
    ),
  };

  return (
    <section className="card detail-tabs">
      <div className="dt-head">
        <div>
          <h3 className="card-title">The detail</h3>
          <p className="card-sub">
            {o.reconciles ? (
              <span className="ok-text">
                <Icon name="check" size={13} /> Every source sums to its total, to the paise.
              </span>
            ) : (
              <span className="bad-text">
                <Icon name="x" size={13} /> A source does NOT sum to its total.
              </span>
            )}
          </p>
        </div>
        <div className="segmented" role="tablist" aria-label="Detail">
          {(Object.keys(DETAIL_NAMES) as Detail[]).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={view === d}
              className={view === d ? 'on' : ''}
              onClick={() => setView(d)}
            >
              {DETAIL_NAMES[d]}
            </button>
          ))}
        </div>
      </div>
      <div className="dt-body" role="tabpanel" key={view}>
        {body[view]}
      </div>
    </section>
  );
}

/**
 * The Ziro gap as a journey: what the rules left, minus what is settled (approved, or auto-accepted), leaves what
 * is waiting for you (AI proposals the checker verified) and what is still open. Every figure is from the report;
 * the headline counts down from what the rules left to what is still unreconciled.
 */
function GapJourney({ o, runId, needYou }: { o: Overview; runId: string; needYou: number }) {
  const [ref, seen] = useInView<HTMLElement>();
  const settled = settledBy(o);
  const done = toBig(o.gap.explainedPaise);
  const wait = toBig(o.gap.awaitingPaise);
  const open = toBig(o.gap.openPaise);
  const left = done + wait + open;
  const ledger = o.coverage.find((c) => c.type === 'ledger_entry');
  const share = (n: bigint): number => (left === 0n ? 0 : ratio(n, left));
  const steps = [
    { key: 'left', label: 'Left after rules', from: 0n, size: left, color: 'var(--axis)' },
    {
      key: 'done',
      label: settled.label,
      from: wait + open,
      size: done,
      color: STATE[settled.state].color,
    },
    {
      key: 'wait',
      label: 'AI verified, waiting for you',
      from: open,
      size: wait,
      color: STATE.wait.color,
    },
    { key: 'open', label: 'Still open', from: 0n, size: open, color: STATE.open.color },
  ].filter((step) => step.key === 'left' || step.size > 0n);
  const clear = wait + open === 0n;
  return (
    <section ref={ref} className={`card gap-card ${seen ? 'in' : ''} ${clear ? 'clear' : ''}`}>
      <span className="kicker">{clear ? 'Fully reconciled' : 'Still unreconciled'}</span>
      <div className="gap-figure">
        <CountDownPaise from={left} to={wait + open} />
      </div>
      {ledger ? (
        <p className="gap-orders">
          Rules proved {ledger.matched} of {ledger.total} orders ({inr(ledger.amountPaise.matched)}{' '}
          of {inr(ledger.amountPaise.total)}). What they left, counted once per case:
        </p>
      ) : null}
      <ol className="wf" aria-label="The gap, step by step">
        {steps.map((step, i) => (
          <li key={step.key}>
            <span className="wf-label">{step.label}</span>
            <span className="wf-track">
              <span
                className="wf-fill"
                style={{
                  left: `${share(step.from) * 100}%`,
                  width: `${Math.max(share(step.size) * 100, 0.6)}%`,
                  background: step.color,
                  transitionDelay: `${i * MOTION.stagger * 2}ms`,
                }}
              />
            </span>
            <b className="wf-value">
              {step.key === 'left' ? '' : '−'}
              {inr(String(step.size))}
            </b>
          </li>
        ))}
      </ol>
      {done === 0n && wait > 0n ? (
        <p className="gap-note">
          Nothing counts as settled until a person approves it, and auto-accept is off for demo
          runs.
        </p>
      ) : null}
      <a
        className={`button ${needYou > 0 ? 'primary' : ''} next-action`}
        href={linkTo(runId, 'exceptions')}
      >
        {needYou > 0 ? (
          <>
            Review {needYou} exception{needYou === 1 ? '' : 's'} <Icon name="arrow" size={15} />
          </>
        ) : (
          <>
            <Icon name="check" size={15} /> Nothing needs you
          </>
        )}
      </a>
    </section>
  );
}
