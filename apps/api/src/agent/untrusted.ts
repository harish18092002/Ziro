// Free text in a record (a memo, a bank narration, a settlement line's description) is written by a
// third party. It reaches the model only inside <untrusted> tags, only in tool results, and it cannot
// close that tag: any opening or closing "untrusted" tag inside it is defanged first.

/** The fields whose text is untrusted. Fixed, so a tag's `field` can never be attacker-chosen. */
export type UntrustedField = 'memo' | 'customer_ref' | 'narration' | 'description' | 'reference';

export const MAX_UNTRUSTED_CHARS = 300;

/** What an order reference or receipt looks like. Anything else is free text and is treated as such. */
const PLAIN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._\-/:#]{0,63}$/;

/**
 * A merchant-chosen reference (order_ref, receipt). Real ones are plain tokens and pass through, so the
 * model sees `ORD-1001`; a "reference" that is really a sentence is wrapped like any other free text.
 */
export function identifier(value: string): string {
  return PLAIN_REFERENCE.test(value) ? value : (untrusted('reference', value) ?? '');
}

export function untrusted(field: UntrustedField, text: string | null): string | null {
  if (text === null) return null;
  const clipped =
    text.length > MAX_UNTRUSTED_CHARS
      ? `${text.slice(0, MAX_UNTRUSTED_CHARS)}...[truncated]`
      : text;
  // "<untrusted" and "</untrusted" (any case, whitespace allowed around the slash) lose their bracket.
  const defanged = clipped.replace(/<(\s*\/?\s*untrusted)/gi, '&lt;$1');
  return `<untrusted field="${field}">${defanged}</untrusted>`;
}
