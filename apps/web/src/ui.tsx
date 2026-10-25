import type { CSSProperties, ReactNode } from 'react';
import { compact, scaleBig, toBig } from './chart-math';
import { inr } from './format';
import { useEased, useInView } from './hooks';
import { Icon } from './Icons';

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
  const t = useEased(seen, 1400);
  return <span ref={ref}>{inr(String(scaleBig(toBig(paise), t)))}</span>;
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
