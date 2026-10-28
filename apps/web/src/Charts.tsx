import { type FocusEvent, type PointerEvent, type ReactNode, useCallback, useState } from 'react';
import { labelFits, ratio, segmentWeights } from './chart-math';
import { percent } from './format';
import { useEased, useInView } from './hooks';
import { Icon, type IconName } from './Icons';
import { MOTION } from './motion';
import type { TipAnchor } from './place';
import { anchorOf, cssVars, Floating } from './ui';

// Charts built from plain HTML and SVG, to the charting method: thin marks, a 2px surface gap between
// touching fills, values written out (never colour alone), a legend for two or more series, a tooltip on
// hover AND keyboard focus, and a table view for every chart. Colours are the validated theme tokens.

// ---------- tooltip ----------

export interface TipRow {
  label: string;
  value: string;
  color?: string;
}
export interface TipContent {
  title: string;
  rows: TipRow[];
}
interface TipState {
  anchor: TipAnchor;
  content: TipContent;
}

/**
 * One tooltip per chart. `bind(content)` makes any element a hover and focus target for it. On hover it follows
 * the pointer across the mark but sits on the mark's top edge, so it does not jitter up and down.
 */
function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const bind = (content: TipContent) => ({
    tabIndex: 0,
    onPointerMove: (e: PointerEvent<HTMLElement>) =>
      setTip({ anchor: anchorOf(e.currentTarget, e.clientX), content }),
    onPointerLeave: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => setTip({ anchor: anchorOf(e.currentTarget), content }),
    onBlur: hide,
  });
  return {
    bind,
    node: tip ? (
      <Floating anchor={tip.anchor} className="tip" onDismiss={hide}>
        <div className="tip-title">{tip.content.title}</div>
        {tip.content.rows.map((r) => (
          <div className="tip-row" key={r.label}>
            {r.color ? <i className="tip-key" style={{ background: r.color }} /> : null}
            <b>{r.value}</b>
            <span>{r.label}</span>
          </div>
        ))}
      </Floating>
    ) : null,
  };
}

// ---------- card, legend, table twin ----------

export interface DataTableProps {
  columns: string[];
  rows: string[][];
  /** Column indexes holding numbers, right-aligned. */
  numeric?: number[];
}

export function DataTable({ columns, rows, numeric = [] }: DataTableProps) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={numeric.includes(i) ? 'n' : ''}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} className={numeric.includes(ci) ? 'n' : ''}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart with its title and, when it has a table twin, a quiet "Show as table" link in its footer. */
export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  foot,
  className = '',
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: ReactNode;
  table?: DataTableProps;
  foot?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure className={`card chart-card ${className}`}>
      <figcaption className="card-head">
        <div>
          <h3 className="card-title">{title}</h3>
          {subtitle ? <p className="card-sub">{subtitle}</p> : null}
        </div>
      </figcaption>
      {view === 'chart' ? (
        <>
          {legend}
          {children}
        </>
      ) : table ? (
        <DataTable {...table} />
      ) : null}
      {foot || table ? (
        <div className="card-foot">
          <span>{foot}</span>
          {table ? (
            <button
              className="linkbtn"
              aria-pressed={view === 'table'}
              onClick={() => setView(view === 'table' ? 'chart' : 'table')}
            >
              {view === 'table' ? 'Show chart' : 'Show as table'}
            </button>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** What this series adds up to, shown after its name. */
  value?: string;
  /** An icon beside the swatch: a money state always has one, so colour never carries the meaning alone. */
  icon?: IconName;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.key}>
          <i className="sw" style={{ background: i.color }} />
          {i.icon ? <Icon name={i.icon} size={13} className="legend-ico" /> : null}
          <span>{i.label}</span>
          {i.value ? <b>{i.value}</b> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------- stacked bars ----------

export interface Segment {
  key: string;
  label: string;
  value: bigint;
  /** A CSS colour (a theme token). */
  color: string;
  /** The ink for the value written inside the segment; defaults to white. */
  ink?: string;
  /** Written beside the count in the tooltip, e.g. the rupees these records add up to. */
  detail?: string;
  /** Written instead of the count, inside the segment and in the tooltip: for a value that is not a count. */
  shown?: string;
}
export interface StackRow {
  id: string;
  label: string;
  href?: string;
  segments: Segment[];
  /** Shown at the end of the row; defaults to the segments' sum. */
  totalLabel?: string;
}

/**
 * Part-to-whole bars: each row is 100%, shared out between its segments with a 2px gap. A value is written
 * inside its segment only when it fits; every value is also in the tooltip and in the table twin. The segments
 * always have their real widths; the bar slides in from the left the first time it is seen (a transform).
 */
export function StackedBars({ rows, tall = false }: { rows: StackRow[]; tall?: boolean }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const { bind, node } = useTooltip();
  return (
    <div ref={ref} className={`sbars ${seen ? 'in' : ''} ${tall ? 'tall' : ''}`}>
      {rows.map((row, r) => {
        const weights = segmentWeights(row.segments.map((s) => s.value));
        const total = row.segments.reduce((n, s) => (s.value > 0n ? n + s.value : n), 0n);
        return (
          <div className="sbar-row" key={row.id}>
            {row.label ? (
              <div className="sbar-head">
                {row.href ? <a href={row.href}>{row.label}</a> : <span>{row.label}</span>}
                <b>{row.totalLabel ?? total.toLocaleString('en-IN')}</b>
              </div>
            ) : null}
            <div
              className="sbar"
              role="img"
              aria-label={`${row.label}: ${row.segments.map((s) => `${s.label} ${s.value}`).join(', ')}`}
            >
              <div className="sbar-track" style={{ transitionDelay: `${r * MOTION.stagger}ms` }}>
                {row.segments.map((s, i) => {
                  const weight = weights[i] ?? 0;
                  if (weight === 0) return null;
                  const share = ratio(s.value, total);
                  const shown = s.shown ?? s.value.toLocaleString('en-IN');
                  return (
                    <span
                      key={s.key}
                      className="sbar-seg"
                      style={{ flexGrow: weight, background: s.color, color: s.ink }}
                      {...bind({
                        title: row.label || s.label,
                        rows: [
                          {
                            label: s.label,
                            value: `${shown} · ${percent(share)}`,
                            color: s.color,
                          },
                          ...(s.detail ? [{ label: 'adds up to', value: s.detail }] : []),
                        ],
                      })}
                    >
                      {labelFits(share, shown.length) ? (
                        <span className="sbar-in">{shown}</span>
                      ) : null}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      {node}
    </div>
  );
}

// ---------- horizontal bars ----------

export interface BarItem {
  id: string;
  label: string;
  /** A second line under the label. */
  sub?: string;
  value: bigint;
  /** The written value, at the end of the label row. */
  display: string;
  color: string;
  href?: string;
  tip?: TipContent;
}

/** One thin bar per row, all drawn to the same scale: the longest is full width. */
export function BarList({ items }: { items: BarItem[] }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const { bind, node } = useTooltip();
  const max = items.reduce((m, i) => (i.value > m ? i.value : m), 0n);
  return (
    <div ref={ref} className={`bars ${seen ? 'in' : ''}`}>
      {items.map((it, i) => {
        const fill = Math.max(ratio(it.value, max), it.value > 0n ? 0.012 : 0);
        return (
          <div className="bar-row" key={it.id}>
            <div className="bar-head">
              <span className="bar-label">
                {it.href ? <a href={it.href}>{it.label}</a> : it.label}
                {it.sub ? <small>{it.sub}</small> : null}
              </span>
              <b>{it.display}</b>
            </div>
            <div
              className="bar-track"
              {...bind(
                it.tip ?? {
                  title: it.label,
                  rows: [{ label: it.sub ?? 'value', value: it.display, color: it.color }],
                },
              )}
            >
              <span className="bar-clip" style={{ width: `${fill * 100}%` }}>
                <span
                  className="bar-fill"
                  style={{ background: it.color, transitionDelay: `${i * MOTION.stagger}ms` }}
                />
              </span>
            </div>
          </div>
        );
      })}
      {node}
    </div>
  );
}

// ---------- ring meter ----------

const RING = 62;
const CIRC = 2 * Math.PI * RING;

/** A single ratio against a whole, as a ring that fills and a figure that counts up. */
export function RingMeter({
  value,
  label,
  sub,
  color = 'var(--st-rules)',
}: {
  value: number;
  label: string;
  sub?: string;
  color?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const t = useEased(seen);
  const v = Math.min(1, Math.max(0, value));
  return (
    <div ref={ref} className="ring-meter">
      <svg
        viewBox="0 0 160 160"
        role="img"
        aria-label={`${label}: ${percent(v)}`}
        className="ring-svg"
      >
        <circle cx="80" cy="80" r={RING} fill="none" stroke="var(--hair)" strokeWidth="12" />
        <circle
          className="ring-fill"
          cx="80"
          cy="80"
          r={RING}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          transform="rotate(-90 80 80)"
          style={{
            strokeDasharray: CIRC,
            strokeDashoffset: seen ? CIRC * (1 - v) : CIRC,
          }}
        />
        <text x="80" y="86" textAnchor="middle" className="ring-text" fill="var(--ink)">
          {percent(v * t)}
        </text>
      </svg>
      <div className="ring-words">
        <b>{label}</b>
        {sub ? <span>{sub}</span> : null}
      </div>
    </div>
  );
}

/** A thin meter: the fill carries the ratio, the track is a lighter step of the same colour. */
export function Meter({
  value,
  color = 'var(--brand-blue)',
  label,
}: {
  value: number;
  color?: string;
  label: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const v = Math.min(1, Math.max(0, value));
  return (
    <div
      ref={ref}
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      style={cssVars({ '--meter': color })}
    >
      <span style={{ transform: `translateX(${seen ? (v - 1) * 100 : -100}%)` }} />
    </div>
  );
}
