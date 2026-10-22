/**
 * A parse that says why it failed instead of throwing. Bulk imports read thousands of cells and
 * must collect every reason (row, field, reason), so the normalizers return this and never throw.
 */
export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export const accept = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const reject = (reason: string): Parsed<never> => ({ ok: false, reason });
