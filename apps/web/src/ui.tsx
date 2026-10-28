import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { compact, scaleBig, toBig } from './chart-math';
import { inr } from './format';
import { useEased, useInView } from './hooks';
import { Icon } from './Icons';
import { GLOSSARY, type TermKey } from './glossary';
import type { Metric } from './metrics';
import { type Placement, placeTip, type TipAnchor } from './place';

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

/** The anchor for an element: its centre, or `x` (the pointer) when given, and its top and bottom edges. */
export function anchorOf(el: Element, x?: number): TipAnchor {
  const box = el.getBoundingClientRect();
  return { x: x ?? box.left + box.width / 2, top: box.top, bottom: box.bottom };
}

/**
 * Every tooltip's box. It is drawn at the end of <body> (a portal), not inside the card it belongs to: a card
 * that lifts or reveals has a transform, which would make a fixed box move with the card and land away from the
 * pointer, and a card's overflow would cut it off. It is measured, put above its anchor (below when there is no
 * room) and kept on screen. It closes when the page scrolls or resizes, since its anchor moves.
 */
export function Floating({
  anchor,
  id,
  className,
  onDismiss,
  children,
}: {
  anchor: TipAnchor;
  id?: string;
  className: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const next = placeTip(
      anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: document.documentElement.clientWidth, height: window.innerHeight },
    );
    setPlace((prev) =>
      prev?.left === next.left && prev.top === next.top && prev.side === next.side ? prev : next,
    );
  });

  useEffect(() => {
    const close = () => dismiss.current();
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`floating ${className}`}
      data-side={place?.side}
      style={
        place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
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
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const show = () => {
    if (button.current !== null) setAnchor(anchorOf(button.current));
  };
  const hide = () => setAnchor(null);
  const open = anchor !== null;
  return (
    <span className="tip-wrap" onPointerEnter={show} onPointerLeave={hide}>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={show}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
        }}
      >
        {children}
      </button>
      {anchor !== null ? (
        <Floating anchor={anchor} id={id} className="tip-pop" onDismiss={hide}>
          <b>{title}</b>
          {text}
        </Floating>
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
