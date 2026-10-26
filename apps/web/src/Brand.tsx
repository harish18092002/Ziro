/** The mark: a zero (the goal) with the paisa at its centre, on the brand gradient. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-blue)" />
          <stop offset="1" stopColor="var(--brand-violet)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#logo-g)" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="16" cy="16" r="1.9" fill="#fff" />
    </svg>
  );
}
