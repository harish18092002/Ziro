import { type CSSProperties, type ReactNode, useId, useState } from 'react';
import { compact, scaleBig, toBig } from './chart-math';
import { inr } from './format';
import { useEased, useInView } from './hooks';
import { Icon } from './Icons';
import { GLOSSARY, type TermKey } from './glossary';
import type { Metric } from './metrics';

/** A style object that carries CSS custom properties (`--i`, `--w`): React sets them through the CSSOM. */
export const cssVars = (vars: Record<string, string | number>): CSSProperties => vars;

/** Fades and lifts its children in the first time they scroll into view; `i` staggers siblings. */
export function Reveal({
  i = 0,
  className = '',
  children,
}: {
  i?: number;
  className?: string;
  children: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`reveal ${seen ? 'in' : ''} ${className}`}
      style={cssVars({ '--i': i })}
    >
      {children}
    </div>
  );
}

/** A whole number that counts up from 0 when it scrolls into view. */
export function Count({
  value,
  format = compact,
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const t = useEased(seen);
  return <span ref={ref}>{format(value * t)}</span>;
}

/** Rupees that count up from ₹0.00 to the amount, in whole paise: it never leaves integers. */
export function CountPaise({ paise }: { paise: string | null | undefined }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const t = useEased(seen);
  return <span ref={ref}>{inr(String(scaleBig(toBig(paise), t)))}</span>;
}

/** Rupees counting DOWN from one amount to another when seen, in whole paise (the gap closing). */
export function CountDownPaise({ from, to }: { from: bigint; to: bigint }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const t = useEased(seen);
  const now = from - scaleBig(from - to, t);
  return <span ref={ref}>{inr(String(now))}</span>;
}

/** A notice above the page content: an icon, a coloured edge and the words. */
export function Banner({
  tone = 'info',
  role = 'status',
  children,
}: {
  tone?: 'info' | 'warn' | 'bad';
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`} role={role}>
      <Icon name={tone === 'info' ? 'info' : 'alert'} size={20} />
      <div className="body">{children}</div>
    </div>
  );
}

/**
 * A small tooltip on a button: it opens on hover, keyboard focus and a tap, and closes on leaving, blur or Escape.
 * A click only ever opens it, so a hover followed by a click does not shut it again.
 */
function Tip({
  className,
  label,
  title,
  text,
  children,
}: {
  className: string;
  label: string;
  title: string;
  text: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="tip-wrap"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {children}
      </button>
      {open ? (
        <span role="tooltip" id={id} className="tip-pop">
          <b>{title}</b>
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** A small ⓘ with a titled note: for the developer detail that should not sit in the page's own words. */
export function InfoTip({ label, title, text }: { label: string; title: string; text: string }) {
  return (
    <Tip className="how-btn" label={label} title={title} text={text}>
      <Icon name="info" size={13} />
    </Tip>
  );
}

/** "How we count": a small info button that says what a number counts, out of what, and where it comes from. */
export function HowWeCount({ label, how }: { label: string; how: string }) {
  return (
    <Tip className="how-btn" label={`How we count: ${label}`} title="How we count" text={how}>
      <Icon name="info" size={13} />
    </Tip>
  );
}

/** A word of jargon, underlined with dots: its plain meaning on hover, focus or a tap. */
export function Term({ k, children }: { k: TermKey; children: string }) {
  return (
    <Tip className="term" label={`${children}: what it means`} title="Means" text={GLOSSARY[k]}>
      {children}
    </Tip>
  );
}

/** One measured number: the figure counts up when seen, then its label, its denominator and how it is counted. */
export function Stat({ m }: { m: Metric }) {
  return (
    <div className="card stat">
      <b className="stat-figure">
        <Count value={m.n} format={m.format} />
      </b>
      <span className="stat-label">
        {m.label}
        <HowWeCount label={m.label} how={m.how} />
      </span>
      {m.of ? <span className="stat-of">{m.of}</span> : null}
    </div>
  );
}
