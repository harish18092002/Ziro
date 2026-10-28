/** The mark: a zero (the goal) with the paisa at its centre, on the brand blue. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="16" cy="16" r="1.9" fill="#fff" />
    </svg>
  );
}
