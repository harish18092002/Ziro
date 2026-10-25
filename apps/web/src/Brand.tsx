/** The mark: a zero (the goal) with the paisa at its centre, on the brand gradient. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--c-matched)" />
          <stop offset="1" stopColor="var(--violet)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#logo-g)" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="16" cy="16" r="1.9" fill="#fff" />
    </svg>
  );
}

const RING_R = 78;

/**
 * The home page picture: the three sources flow into a ring that closes on "₹0.00 unexplained".
 * It is drawn with CSS animation only (the flow lines, the ring closing, the badge popping), so a viewer
 * who asks for reduced motion sees the finished picture.
 */
export function HeroArt() {
  return (
    <svg
      className="hero-art"
      viewBox="0 0 540 380"
      role="img"
      aria-label="Your ledger, Razorpay and the bank statement flow into a ring that closes on zero rupees unexplained"
    >
      <defs>
        <linearGradient
          id="ring-g"
          x1="340"
          y1="110"
          x2="500"
          y2="270"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--c-matched)" />
          <stop offset="1" stopColor="var(--violet)" />
        </linearGradient>
        <radialGradient id="ring-glow">
          <stop offset="0" stopColor="var(--c-matched)" stopOpacity="0.2" />
          <stop offset="1" stopColor="var(--c-matched)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="420" cy="190" r="150" fill="url(#ring-glow)" />

      <g className="flows" fill="none" strokeLinecap="round">
        <path className="stream s1" d="M192 72 C 270 72, 270 190, 336 190" />
        <path className="stream s2" d="M192 190 L 336 190" />
        <path className="stream s3" d="M192 308 C 270 308, 270 190, 336 190" />
      </g>

      <Source y={44} icon="book" title="Order ledger" note="orders and amounts" />
      <Source y={162} icon="rupee" title="Razorpay" note="payments and payouts" />
      <Source y={280} icon="bank" title="Bank statement" note="credits and UTRs" />

      <g transform="translate(420 190)">
        <circle
          className="pulse-ring"
          r={RING_R}
          fill="none"
          stroke="url(#ring-g)"
          strokeWidth="2"
        />
        <circle r={RING_R} fill="var(--card)" stroke="var(--hair)" strokeWidth="14" />
        <circle
          className="ring-arc"
          r={RING_R}
          fill="none"
          stroke="url(#ring-g)"
          strokeWidth="14"
          strokeLinecap="round"
          transform="rotate(-90)"
        />
        <text className="ring-figure" y="4" textAnchor="middle" fill="var(--ink)">
          ₹0.00
        </text>
        <text y="26" textAnchor="middle" fontSize="12.5" fill="var(--ink-3)">
          unexplained
        </text>
        <g transform="translate(56 -60)">
          <g className="ring-badge">
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

      <g className="chip-float c1">
        <rect
          x="318"
          y="46"
          width="108"
          height="28"
          rx="14"
          fill="var(--card)"
          stroke="var(--hair)"
        />
        <circle cx="334" cy="60" r="4" fill="var(--c-matched)" />
        <text x="346" y="64.5" fontSize="12" fontWeight="600" fill="var(--ink)">
          fee + GST ✓
        </text>
      </g>
      <g className="chip-float c2">
        <rect
          x="392"
          y="312"
          width="118"
          height="28"
          rx="14"
          fill="var(--card)"
          stroke="var(--hair)"
        />
        <circle cx="408" cy="326" r="4" fill="var(--c-waiting)" />
        <text x="420" y="330.5" fontSize="12" fontWeight="600" fill="var(--ink)">
          T+2 batch ✓
        </text>
      </g>
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
