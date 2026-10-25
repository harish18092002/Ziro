// What the test-payments page does with numbers, apart from the page: tested on its own.

/**
 * Rupees as typed ("500", "1,234.5", "99.99") to whole paise, in integers: never a float. Null for anything
 * that is not a plain amount in Razorpay's order range (Re 1 to Rs 10,000, at most two decimals).
 */
export function rupeesToPaise(text: string): number | null {
  const clean = text.trim().replaceAll(',', '');
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(clean);
  if (match === null) return null;
  const rupees = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const paise = rupees * 100 + fraction;
  return paise >= 100 && paise <= 1_000_000 ? paise : null;
}

/** 52730 as "₹527.30": only for showing back what was just made. */
export function showPaise(paise: number): string {
  return `₹${Math.floor(paise / 100).toLocaleString('en-IN')}.${String(paise % 100).padStart(2, '0')}`;
}
