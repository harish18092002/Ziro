import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  get,
  post,
  reasonOf,
  type RefundResult,
  type TestPayment,
  type TestPaymentList,
} from './api';
import { inr } from './format';
import { Icon } from './Icons';
import {
  paidAt,
  parseRefund,
  rupeesText,
  shortId,
  statusView,
  summarize,
  type PaymentsSummary,
} from './test-account';
import { Banner } from './ui';

/** Coming back to the tab refreshes the list, but not twice for one return. */
const REFRESH_GAP_MS = 1_500;

interface Props {
  readonly from: string;
  readonly to: string;
  readonly onFrom: (value: string) => void;
  readonly onTo: (value: string) => void;
  /** The dates are fixed once a reconciliation has been started from them. */
  readonly locked: boolean;
  /** Told whenever a fresh list arrives, so the page can say how many payments it would import. */
  readonly onList: (list: TestPaymentList) => void;
}

/**
 * Your Razorpay test account, live: the payments it holds right now, read from Razorpay when this opens, when
 * you press Refresh and when you come back to the tab, with a Refund button where Razorpay allows one.
 */
export function PaymentsPanel({ from, to, onFrom, onTo, locked, onList }: Props) {
  const [list, setList] = useState<TestPaymentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const latest = useRef(0);
  const loadedAt = useRef(0);
  const valid = from !== '' && to !== '' && from <= to;

  const load = useCallback(async () => {
    if (!valid) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const out = await get<TestPaymentList>(`/razorpay/test-payments?from=${from}&to=${to}`);
      if (mine !== latest.current) return; // an older answer arriving late
      loadedAt.current = Date.now();
      setList(out);
      setProblem(null);
      onList(out);
    } catch (error) {
      if (mine === latest.current) setProblem(reasonOf(error));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [from, to, valid, onList]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const comeBack = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - loadedAt.current < REFRESH_GAP_MS) return;
      void load();
    };
    window.addEventListener('focus', comeBack);
    document.addEventListener('visibilitychange', comeBack);
    return () => {
      window.removeEventListener('focus', comeBack);
      document.removeEventListener('visibilitychange', comeBack);
    };
  }, [load]);

  const payments = list?.payments ?? [];
  const summary = summarize(payments);

  return (
    <section className="card live" aria-labelledby="live-title">
      <div className="live-head">
        <div>
          <h3 id="live-title">Payments in your test account</h3>
          <p className="muted small">
            {list
              ? `Read from Razorpay at ${new Date(list.fetchedAt).toLocaleTimeString('en-IN', { timeStyle: 'medium' })}.`
              : 'Reading from Razorpay…'}{' '}
            It refreshes when you come back to this tab.
          </p>
        </div>
        <div className="range">
          <label>
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to}
              disabled={locked}
              onChange={(e) => onFrom(e.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from}
              disabled={locked}
              onChange={(e) => onTo(e.target.value)}
            />
          </label>
          <button type="button" onClick={() => void load()} disabled={loading || !valid}>
            {loading ? <span className="spinner" /> : <Icon name="refresh" size={15} />} Refresh
          </button>
        </div>
      </div>

      {!valid ? (
        <Banner tone="warn">Pick a start date that is not after the end date.</Banner>
      ) : null}
      {problem ? (
        <Banner tone="bad" role="alert">
          {problem}
        </Banner>
      ) : null}
      {list && !list.complete ? (
        <Banner tone="warn">
          Razorpay stopped answering part-way, so this list may be missing some payments. Press
          Refresh to try again.
        </Banner>
      ) : null}
      {list?.truncated ? (
        <Banner tone="info">
          Showing the newest 500 payments. Narrow the dates to see the rest.
        </Banner>
      ) : null}
      {done ? <Banner tone="info">{done}</Banner> : null}

      {list ? <SummaryLine summary={summary} /> : null}

      {summary.notCaptured > 0 ? (
        <Banner tone="warn">
          {summary.notCaptured} {summary.notCaptured === 1 ? 'payment is' : 'payments are'} not
          captured. Razorpay refunds only captured payments, and normally captures by itself. If
          yours does not, open <b>Account &amp; Settings → Payments Capture</b> in your Razorpay
          test dashboard and choose automatic capture.
        </Banner>
      ) : null}

      {list === null && loading ? (
        <div className="stack">
          <div className="skel row-skel" />
          <div className="skel row-skel" />
        </div>
      ) : null}

      {list && payments.length === 0 && !loading ? (
        <p className="empty">
          No payments between {from} and {to}. Make one with the steps above, or widen the dates.
        </p>
      ) : null}

      {payments.length > 0 ? (
        <div className={`table-wrap${loading ? ' loading' : ''}`}>
          <table className="data stackable">
            <thead>
              <tr>
                <th>Order</th>
                <th className="n">Amount</th>
                <th>Status</th>
                <th>Paid</th>
                <th>
                  <span className="sr-only">Refund</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <PaymentRows
                  key={p.paymentId}
                  p={p}
                  open={openId === p.paymentId}
                  onToggle={() => setOpenId(openId === p.paymentId ? null : p.paymentId)}
                  onRefunded={(result) => {
                    setOpenId(null);
                    setDone(
                      `Refunded ${inr(String(result.amountPaise))} of ${p.receipt ?? p.paymentId} (${result.refundId}).`,
                    );
                    void load();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function SummaryLine({ summary }: { summary: PaymentsSummary }) {
  if (summary.count === 0) return null;
  return (
    <p className="live-summary">
      <b>{summary.count}</b> {summary.count === 1 ? 'payment' : 'payments'}
      <span>
        <b>{inr(summary.capturedPaise)}</b> captured
      </span>
      {summary.refunded > 0 ? (
        <span>
          <b>{inr(summary.refundedPaise)}</b> refunded
        </span>
      ) : null}
      {summary.failed > 0 ? <span>{summary.failed} failed</span> : null}
    </p>
  );
}

function PaymentRows({
  p,
  open,
  onToggle,
  onRefunded,
}: {
  p: TestPayment;
  open: boolean;
  onToggle: () => void;
  onRefunded: (result: RefundResult) => void;
}) {
  const view = statusView(p);
  return (
    <>
      <tr className={open ? 'open' : undefined}>
        <td data-label="Order">
          <b>{p.receipt ?? '–'}</b>
          <span className="row-sub">
            <code title={p.paymentId}>{shortId(p.paymentId)}</code> · {p.method}
          </span>
        </td>
        <td data-label="Amount" className="n">
          {inr(p.amountPaise)}
        </td>
        <td data-label="Status">
          <span className={`pill ${view.tone === 'plain' ? '' : view.tone}`}>{view.label}</span>
          {p.amountRefundedPaise !== '0' ? (
            <span className="row-sub">{inr(p.amountRefundedPaise)} refunded</span>
          ) : null}
        </td>
        <td data-label="Paid">{paidAt(p.createdAt)}</td>
        <td data-label="" className="act">
          {p.canRefund ? (
            <button type="button" className="sm" onClick={onToggle} aria-expanded={open}>
              {open ? 'Close' : 'Refund'}
            </button>
          ) : (
            <span className="muted small" title={p.cannotRefundBecause ?? undefined}>
              {p.cannotRefundBecause ? 'No refund' : ''}
            </span>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="refund-row">
          <td colSpan={5}>
            <RefundForm p={p} onDone={onRefunded} onCancel={onToggle} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RefundForm({
  p,
  onDone,
  onCancel,
}: {
  p: TestPayment;
  onDone: (result: RefundResult) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(rupeesText(p.refundablePaise));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const parsed = parseRefund(text, p);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok) {
      setProblem(parsed.why);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onDone(
        await post<RefundResult>('/razorpay/test-refunds', {
          paymentId: p.paymentId,
          amountPaise: parsed.paise,
        }),
      );
    } catch (error) {
      setProblem(reasonOf(error));
      setBusy(false);
    }
  };

  return (
    <form className="refund-form" onSubmit={(e) => void submit(e)}>
      <label>
        <span>Refund amount, in rupees</span>
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={!parsed.ok}
          autoComplete="off"
          autoFocus
        />
      </label>
      <div className="quick">
        <button
          type="button"
          className="ghost sm"
          onClick={() => setText(rupeesText(p.refundablePaise))}
        >
          All {inr(p.refundablePaise)}
        </button>
        <button type="button" className="ghost sm" onClick={() => setText('1.00')}>
          Just ₹1
        </button>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy || !parsed.ok}>
          {busy ? <span className="spinner" /> : null} Refund{' '}
          {parsed.ok ? inr(String(parsed.paise)) : ''}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted small hint">
        {parsed.ok ? (
          'Refunds are paid out of your test balance. If Razorpay refuses without a reason, try a smaller amount such as ₹1.'
        ) : (
          <span className="bad-text">{parsed.why}</span>
        )}
      </p>
      {problem ? (
        <Banner tone="bad" role="alert">
          {problem}
        </Banner>
      ) : null}
    </form>
  );
}
