import { useRef } from 'react';
import { inr } from './format';
import { useLoop, usePrefersReducedMotion, useStoryClock } from './hooks';
import {
  checkShown,
  explainedShare,
  FINAL_T,
  fading,
  packetProgress,
  remainingPaise,
  STORY,
  stepsShown,
} from './story';

// The home page picture, telling the product in one loop: ₹ packets flow from the order ledger, Razorpay and the
// bank statement into the ring; the ring's figure counts down from the replay run's real gap as each kind of
// mismatch is explained (a chip pops in); the check mark pops last. It runs only on screen in a visible tab, and
// for reduced motion it is the finished picture. The timeline is story.ts.

const PATHS = [
  'M192 72 C 270 72, 270 190, 336 190',
  'M192 190 L 336 190',
  'M192 308 C 270 308, 270 190, 336 190',
];
const PACKET_FILL = [
  'var(--brand-blue)',
  'color-mix(in srgb, var(--brand-blue) 50%, var(--brand-violet))',
  'var(--brand-violet)',
];
const RING_R = 78;
const RING_CIRC = 2 * Math.PI * RING_R;
/** Where each mismatch chip sits, in the order the steps explain them. */
const CHIPS = [
  { x: 318, y: 40, w: 112 },
  { x: 398, y: 318, w: 116 },
  { x: 262, y: 318, w: 82 },
];

export function HeroStory({ gapPaise }: { gapPaise: bigint | null }) {
  const reduced = usePrefersReducedMotion();
  const [ref, onScreen] = useLoop<SVGSVGElement>();
  const animate = gapPaise !== null && !reduced;
  const clock = useStoryClock(animate && onScreen, STORY.loopMs);
  const t = animate ? clock : FINAL_T;
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const remaining = gapPaise === null ? 0n : remainingPaise(gapPaise, t);
  const share = gapPaise === null ? 1 : explainedShare(gapPaise, t);
  const shown = stepsShown(t);

  return (
    <svg
      ref={ref}
      className={`hero-art story ${fading(t) ? 'fade' : ''}`}
      data-loops={onScreen ? 'on' : 'off'}
      viewBox="0 0 540 380"
      role="img"
      aria-label={`Your order ledger, Razorpay and the bank statement flow into one figure. The gap the rules left${gapPaise === null ? '' : ` in the replay run, ${inr(String(gapPaise))},`} is explained step by step: fee and GST, T+2 batching, then UTRs, until ₹0.00 is unexplained.`}
    >
      <defs>
        <linearGradient
          id="ring-g"
          x1="-80"
          y1="-80"
          x2="80"
          y2="80"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--brand-blue)" />
          <stop offset="1" stopColor="var(--brand-violet)" />
        </linearGradient>
        <radialGradient id="ring-glow">
          <stop offset="0" stopColor="var(--brand-blue)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--brand-blue)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="420" cy="190" r="150" fill="url(#ring-glow)" />

      <g className="flows" fill="none" strokeLinecap="round">
        {PATHS.map((d, i) => (
          <path
            key={d}
            ref={(el) => {
              paths.current[i] = el;
            }}
            className={`stream s${i + 1}`}
            d={d}
          />
        ))}
      </g>

      <Source y={44} icon="book" title="Order ledger" note="orders and amounts" />
      <Source y={162} icon="rupee" title="Razorpay" note="payments and payouts" />
      <Source y={280} icon="bank" title="Bank statement" note="credits and UTRs" />

      {animate
        ? STORY.packets.map((p, i) => {
            const progress = packetProgress(t, p.at);
            const path = paths.current[p.source];
            if (progress === null || !path) return null;
            const point = path.getPointAtLength(path.getTotalLength() * progress);
            const opacity = Math.min(1, progress * 6, (1 - progress) * 6);
            return (
              <g
                key={i}
                className="packet"
                transform={`translate(${point.x} ${point.y})`}
                opacity={opacity}
                aria-hidden="true"
              >
                <circle r="9" fill={PACKET_FILL[p.source]} />
                <text y="3.6" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#fff">
                  ₹
                </text>
              </g>
            );
          })
        : null}

      <g transform="translate(420 190)">
        <circle r={RING_R} fill="var(--card)" stroke="var(--hair)" strokeWidth="14" />
        <circle
          className="story-arc"
          r={RING_R}
          fill="none"
          stroke="url(#ring-g)"
          strokeWidth="14"
          strokeLinecap="round"
          transform="rotate(-90)"
          style={{ strokeDasharray: RING_CIRC, strokeDashoffset: RING_CIRC * (1 - share) }}
        />
        <g className="resettable">
          <text
            className="ring-figure"
            y="-2"
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--ink)"
          >
            {inr(String(remaining))}
          </text>
          <text y="24" textAnchor="middle" fontSize="13" fill="var(--ink-2)">
            unexplained
          </text>
        </g>
        <g transform="translate(56 -60)">
          <g className={`pop resettable ${checkShown(t) ? 'on' : ''}`}>
            <circle r="15" fill="var(--good)" stroke="var(--card)" strokeWidth="3" />
            <path
              d="M-6 0.5l4.2 4.2L6.5 -4"
              fill="none"
              stroke="#fff"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
      </g>

      {STORY.steps.map((s, i) => {
        const c = CHIPS[i];
        if (c === undefined) return null;
        return (
          <g key={s.label} className={`pop chip resettable ${i < shown ? 'on' : ''}`}>
            <rect
              x={c.x}
              y={c.y}
              width={c.w}
              height="28"
              rx="14"
              fill="var(--card)"
              stroke="var(--hair)"
            />
            <circle cx={c.x + 16} cy={c.y + 14} r="4" fill="var(--st-rules)" />
            <text x={c.x + 28} y={c.y + 18.5} fontSize="12" fontWeight="600" fill="var(--ink)">
              {s.label} ✓
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Source({
  y,
  icon,
  title,
  note,
}: {
  y: number;
  icon: 'book' | 'rupee' | 'bank';
  title: string;
  note: string;
}) {
  const glyph = {
    book: 'M7 5h8a3 3 0 0 1 3 3v11H10a3 3 0 0 1-3-3zM7 15a3 3 0 0 1 3-3h8',
    rupee: 'M8 6h9M8 10.5h9M8 6c4.5 0 6 1.6 6 4.5s-2 4.5-6 4.5l7 7',
    bank: 'M4 10l9-5 9 5M6 10v8M10.5 10v8M15.5 10v8M20 10v8M4 21h18',
  }[icon];
  return (
    <g className="source">
      <rect x="8" y={y} width="184" height="56" rx="14" fill="var(--card)" stroke="var(--hair)" />
      <rect x="18" y={y + 11} width="34" height="34" rx="10" fill="var(--brand-soft)" />
      <path
        d={glyph}
        transform={`translate(${18 + 17 - 12} ${y + 11 + 17 - 12})`}
        fill="none"
        stroke="var(--link)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="64" y={y + 24} fontSize="13.5" fontWeight="650" fill="var(--ink)">
        {title}
      </text>
      <text x="64" y={y + 41} fontSize="11.5" fill="var(--ink-3)">
        {note}
      </text>
    </g>
  );
}
