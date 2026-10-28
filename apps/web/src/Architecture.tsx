import { type KeyboardEvent, type ReactNode, useState } from 'react';
import type { ExceptionList, Overview } from './api';
import { inr, sentence, words } from './format';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icons';
import { REASONS } from './reasons';
import { ACTOR, type Actor } from './states';

// The architecture, one stage at a time: a list of the eight stages on the left, and for the chosen one a sentence
// in plain words, a small picture of what it does, the technical detail behind a fold, and a real example read from
// the featured 50-order demo run through the existing endpoints. No stage is drawn as doing anything right now.

type StageKey =
  'ingest' | 'normalize' | 'rules' | 'exceptions' | 'agent' | 'verifier' | 'review' | 'report';

interface Stage {
  key: StageKey;
  name: string;
  actor: Actor;
  icon: IconName;
  plain: string;
  deep: string[];
  visual: ReactNode;
}

const TOOLS = [
  'get_exception',
  'get_ledger_entry',
  'search_ledger',
  'get_payment',
  'list_refunds',
  'get_settlement_composition',
  'compute_expected_settlement',
  'search_bank_lines',
  'get_fee_contract',
];

const TIERS: [string, string, string][] = [
  [
    'T1',
    'Ledger ↔ payment',
    'Same cleaned receipt and an equal amount. Refunds attach to their payment.',
  ],
  [
    'T2',
    'Settlement composition',
    'Σ payments − Σ fees (GST-inclusive) − Σ refunds ± adjustments equals the settlement, to the paisa.',
  ],
  [
    'T3',
    'Settlement ↔ bank by UTR',
    'The UTR found in the narration (exact or rejoined) and an equal amount.',
  ],
  [
    'T4',
    'Settlement ↔ bank by amount',
    'Equal amount within the settlement date + 3 business days, and exactly one candidate on each side.',
  ],
];

const STAGES: Stage[] = [
  {
    key: 'ingest',
    name: 'Ingest',
    actor: 'code',
    icon: 'upload',
    plain:
      'Three sources come in: your order ledger, Razorpay (test mode only), and the bank statement.',
    deep: [
      'CSV files are read by a strict RFC 4180 reader that reports each bad row and carries on.',
      'Razorpay is read through the official SDK with test keys only; the app refuses to boot with a live key.',
      'Every import is one transaction with its audit row; a re-import of the same file changes nothing.',
    ],
    visual: (
      <ul className="av-sources">
        <li>
          <Icon name="book" size={16} /> <b>Ledger CSV</b>{' '}
          <code>order_ref · amount · date · memo</code>
        </li>
        <li>
          <Icon name="rupee" size={16} /> <b>Razorpay</b> <code>pay_ · rfnd_ · setl_ · recon</code>
        </li>
        <li>
          <Icon name="bank" size={16} /> <b>Bank CSV</b>{' '}
          <code>value date · narration · credit</code>
        </li>
      </ul>
    ),
  },
  {
    key: 'normalize',
    name: 'Normalize',
    actor: 'code',
    icon: 'refresh',
    plain:
      'Everything is put in one shape: integer paise, Indian business dates, clean references and UTRs.',
    deep: [
      'Money is a bigint of paise everywhere. No floats; rounding is explicit, half-up.',
      'Razorpay timestamps (Unix seconds, UTC) become IST business dates.',
      'The UTR is pulled out of the narration, and repaired when the bank has broken it up.',
    ],
    visual: (
      <table className="av-table">
        <caption>Illustrative values</caption>
        <tbody>
          <tr>
            <td>
              <code>"1,000.00"</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>100000</code> paise
            </td>
          </tr>
          <tr>
            <td>
              <code>1729622700</code> (UTC)
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>23-10-2024</code> IST
            </td>
          </tr>
          <tr>
            <td>
              <code>NEFT/AXISN2429 7123456/RZP</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              UTR <code>AXISN24297123456</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>" ord-1001 "</code>
            </td>
            <td aria-hidden="true">→</td>
            <td>
              <code>ORD-1001</code>
            </td>
          </tr>
        </tbody>
      </table>
    ),
  },
  {
    key: 'rules',
    name: 'Rules T1–T4',
    actor: 'code',
    icon: 'code',
    plain:
      'A waterfall of four deterministic rules proves the bulk. Strictest first, and never a guess.',
    deep: [
      'Zero tolerance on amounts; tolerance only on dates, in configurable windows.',
      'More than one candidate is ambiguity, and ambiguity is an exception.',
      'Every record ends in exactly one place: a match group, an exception, or ignored.',
    ],
    visual: (
      <ol className="av-tiers">
        {TIERS.map(([tier, name, rule]) => (
          <li key={tier}>
            <span className="av-tier">{tier}</span>
            <div>
              <b>{name}</b>
              <span>{rule}</span>
            </div>
          </li>
        ))}
      </ol>
    ),
  },
  {
    key: 'exceptions',
    name: 'Exceptions',
    actor: 'code',
    icon: 'search',
    plain:
      'Whatever the rules could not match safely is set aside, with a reason code and the records that could fit.',
    deep: [
      'Up to 50 candidate records are attached to each exception.',
      'Bank credits no settlement can explain go straight to a person: there is nothing for the AI to find.',
    ],
    visual: (
      <ul className="av-codes">
        {Object.keys(REASONS).map((code) => (
          <li key={code} title={REASONS[code]}>
            {sentence(code)}
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: 'agent',
    name: 'AI agent',
    actor: 'ai',
    icon: 'bot',
    plain:
      'An AI agent investigates one exception at a time with read-only lookups, and proposes. It cannot write a match.',
    deep: [
      'Default harness, single-shot: the code gathers a fixed bundle of lookups, then ONE structured call.',
      'Alternative, loop: the model calls the tools itself, at most four times.',
      'Ledger memos and bank narrations reach it inside <untrusted> tags; instructions in them are ignored.',
      'Every claim must cite a lookup by number, or it is downgraded to "needs a human".',
    ],
    visual: (
      <div className="av-tools">
        <span className="slash">Nine read-only tools, scoped to one run</span>
        <ul>
          {TOOLS.map((t) => (
            <li key={t}>
              <code>{t}</code>
            </li>
          ))}
        </ul>
      </div>
    ),
  },
  {
    key: 'verifier',
    name: 'Checker',
    actor: 'code',
    icon: 'shield',
    plain:
      'Plain code re-computes every proposal from the records. If one paisa is off, it refuses.',
    deep: [
      'The same composition function the rules use; the same date windows.',
      'Records in another run, or already in an accepted match, are refused.',
      'A property test shows any 1-paisa error defeats verification.',
    ],
    visual: (
      <ul className="av-checks">
        {[
          'Σ ledger = Σ payments − refunds, to the paisa',
          'Settlement = payments − fees − refunds ± adjustments',
          'Bank credit = settlement',
          'Dates inside the rule windows',
          'Reason code fits the links',
          'INR only, same run, not already matched',
        ].map((c) => (
          <li key={c}>
            <Icon name="check" size={14} /> {c}
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: 'review',
    name: 'You approve',
    actor: 'you',
    icon: 'user',
    plain:
      'A verified proposal waits for a person. Approve and the match is written; reject with a note and it reopens.',
    deep: [
      'Approval re-verifies inside one transaction; a stale proposal answers 409, not a wrong match.',
      'Auto-accept only when verified, small, confident (≥ 0.85) and switched on. It is off for demo runs.',
    ],
    visual: (
      <div className="av-decide">
        <span className="av-btn ok">
          <Icon name="check" size={14} /> Approve → match written
        </span>
        <span className="av-btn">
          <Icon name="x" size={14} /> Reject + note → reopened
        </span>
      </div>
    ),
  },
  {
    key: 'report',
    name: 'Books & audit',
    actor: 'code',
    icon: 'book',
    plain: 'The run closes into numbers a finance team uses, and every step leaves an audit row.',
    deep: [
      'Every source is partitioned (matched, in an exception, ignored) and must sum to its total.',
      'Fee leakage is judged against the fee contract; undercharges are never netted.',
      'audit_events is append-only: a database trigger refuses UPDATE and DELETE.',
    ],
    visual: (
      <ul className="av-outputs">
        {[
          ['scale', 'Totals that tie out'],
          ['trend', 'Fee leakage'],
          ['clock', 'Late payouts'],
          ['file', 'Tally vouchers'],
          ['list', 'Audit trail'],
        ].map(([icon, label]) => (
          <li key={label}>
            <Icon name={icon as IconName} size={15} /> {label}
          </li>
        ))}
      </ul>
    ),
  },
];

export function Architecture({ demoRun }: { demoRun: string | null }) {
  const [active, setActive] = useState(0);
  const examples = useExamples(demoRun);
  const stage = STAGES[active] ?? STAGES[0];
  if (stage === undefined) return null;
  const actor = ACTOR[stage.actor];

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (i + step + STAGES.length) % STAGES.length;
    setActive(next);
    document.getElementById(`stage-${STAGES[next]?.key}`)?.focus();
  };

  return (
    <div className="arch">
      <ol className="arch-list" role="tablist" aria-orientation="vertical" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li key={s.key} role="presentation">
            <button
              id={`stage-${s.key}`}
              role="tab"
              type="button"
              aria-selected={i === active}
              aria-controls="stage-panel"
              tabIndex={i === active ? 0 : -1}
              className={`arch-tab ${i === active ? 'on' : ''}`}
              style={{ ['--actor' as string]: ACTOR[s.actor].color }}
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="arch-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="arch-ico">
                <Icon name={s.icon} size={16} />
              </span>
              <span className="arch-name">{s.name}</span>
              <span className="arch-who">{ACTOR[s.actor].label}</span>
            </button>
          </li>
        ))}
      </ol>

      <section
        id="stage-panel"
        role="tabpanel"
        aria-labelledby={`stage-${stage.key}`}
        className="arch-panel"
        key={stage.key}
      >
        <header>
          <span className="pipe-actor" style={{ ['--actor' as string]: actor.color }}>
            <Icon name={actor.icon} size={13} /> {actor.label}
          </span>
          <span className="slash">Stage {String(active + 1).padStart(2, '0')} of 08</span>
        </header>
        <h3 className="serif">{stage.name}</h3>
        <p className="arch-plain">{stage.plain}</p>
        <div className="arch-visual">{stage.visual}</div>
        <div className="arch-example">
          <span className="slash">In the 50-order demo run</span>
          <p>{examples[stage.key] ?? 'Loading the demo run…'}</p>
        </div>
        <details className="arch-deep">
          <summary>
            Under the hood <Icon name="arrow" size={13} />
          </summary>
          <ul>
            {stage.deep.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
        <div className="arch-nav">
          <button
            type="button"
            className="ghost sm"
            disabled={active === 0}
            onClick={() => setActive((a) => Math.max(0, a - 1))}
          >
            ← Previous
          </button>
          <button
            type="button"
            className="sm"
            disabled={active === STAGES.length - 1}
            onClick={() => setActive((a) => Math.min(STAGES.length - 1, a + 1))}
          >
            Next stage →
          </button>
        </div>
      </section>
    </div>
  );
}

interface Voucher {
  type: string;
  source: string;
  recordIds: string[];
  debits: { ledger: string; paise: string }[];
}

/** One real example per stage, read from the featured 50-order demo run through the existing endpoints. */
function useExamples(demoRun: string | null): Partial<Record<StageKey, string>> {
  const overview = useLoad<Overview>(demoRun ? `/runs/${demoRun}/overview` : null).data;
  const list = useLoad<ExceptionList>(demoRun ? `/runs/${demoRun}/exceptions` : null).data;
  const report = useLoad<{ vouchers: Voucher[] }>(
    demoRun ? `/runs/${demoRun}/report.json` : null,
  ).data;
  const out: Partial<Record<StageKey, string>> = {};
  if (overview) {
    const s = overview.sources;
    out.ingest = `${s.ledger.records} ledger rows, ${s.payments.records} payments, ${s.refunds.records} refunds, ${s.settlements.records} settlements and ${s.bank.credits.records + s.bank.debits.records} bank lines.`;
    out.normalize = `${inr(s.ledger.amountPaise)} of orders and ${inr(s.payments.feesPaise)} of fees incl. GST, all held as integer paise.`;
    out.report = `${overview.journal.vouchers} vouchers for ${overview.journal.settlementsBooked} settlements; the totals ${overview.reconciles ? 'add up to the paisa' : 'do NOT add up'}.`;
  }
  const receipt = report?.vouchers.find((v) => v.type === 'Receipt' && v.source === 'settlement');
  if (receipt) {
    const setl = receipt.recordIds.find((id) => id.startsWith('setl_')) ?? 'a settlement';
    const pays = receipt.recordIds.filter((id) => id.startsWith('pay_')).length;
    const journal = report?.vouchers.find(
      (v) => v.type === 'Journal' && v.recordIds.includes(setl),
    );
    const leg = (name: string) => journal?.debits.find((d) => d.ledger === name)?.paise ?? '0';
    const net = receipt.debits[0]?.paise ?? '0';
    const fee = leg('Payment Gateway Charges');
    const gst = leg('GST Input Credit');
    const gross = String(BigInt(net) + BigInt(fee) + BigInt(gst));
    out.rules = `${pays} payments of ${inr(gross)} → ${setl}, ${inr(net)} in the bank (fee ${inr(fee)} + GST ${inr(gst)}). Proved to the paisa.`;
  }
  const items = list?.items ?? [];
  const key = (e: (typeof items)[number]) => e.subject?.key ?? e.id.slice(0, 8);
  const first = items.find((e) => !e.listedForAPerson);
  if (first)
    out.exceptions = `${key(first)} · ${sentence(first.reasonCode)} · ${inr(first.amountAtStakePaise)} at stake.`;
  const proposed = items.find((e) => e.proposal?.verifier === 'passed');
  if (proposed?.proposal)
    out.agent = `${key(proposed)}: ${words(proposed.proposal.verdict)}${proposed.proposal.author === 'scripted' ? ' (in the demo a script stands in for the model)' : ''}.`;
  const refused = items.find((e) => e.proposal?.verifier === 'rejected');
  if (refused)
    out.verifier = `${key(refused)}: proposal refused${refused.proposal?.author === 'planted' ? ' (a wrong proposal planted on purpose)' : ''}; it stays open.`;
  const waiting = items.find((e) => e.status === 'proposed');
  if (waiting) out.review = `${key(waiting)}: verified, waiting for your approve or reject.`;
  return out;
}
