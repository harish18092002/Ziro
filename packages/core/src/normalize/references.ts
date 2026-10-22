// Order refs and customer refs are join keys: "ord-100001 ", "ORD-100001" and "ORD-100001" with a
// zero-width space in it must all be the same key, or a payment silently fails to find its order.

// Zero-width space/joiners, word joiner, byte-order mark and soft hyphen: invisible, never meaningful.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const WHITESPACE_RUNS = /\s+/g;
const MAX_PASSES = 4;

function onePass(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(WHITESPACE_RUNS, ' ')
    .trim()
    .toUpperCase();
}

/**
 * The canonical form of a reference: Unicode-compatibility normalised (full-width letters become
 * ASCII), invisible characters removed, whitespace collapsed and trimmed, upper-cased. Empty becomes
 * null. Idempotent: normalising a normalised reference changes nothing. Inner punctuation is kept.
 */
export function normalizeRef(input: string): string | null {
  // Upper-casing can create characters that normalise differently (e.g. ŉ), so run to a fixed point.
  let current = input;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = onePass(current);
    if (next === current) break;
    current = next;
  }
  return current === '' ? null : current;
}
