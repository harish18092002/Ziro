/** Array access that fails loudly instead of returning `undefined` under noUncheckedIndexedAccess. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined)
    throw new Error(`index ${index} is out of range (length ${items.length})`);
  return item;
}

export const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export const minInt = (a: number, b: number): number => (a < b ? a : b);
export const maxInt = (a: number, b: number): number => (a > b ? a : b);

/** Integer division for non-negative operands, without going through floating point. */
export function divFloor(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** Total order on strings by UTF-16 code unit, so sorting never depends on locale. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
