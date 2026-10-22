import { describe, expect, it } from 'vitest';
import { parseAmountCell, parseBalanceCell, parseOptionalAmountCell } from './amounts.js';
import type { Parsed } from './result.js';

const value = <T>(parsed: Parsed<T>): T => {
  if (!parsed.ok) throw new Error(`expected an amount: ${parsed.reason}`);
  return parsed.value;
};
const why = (parsed: Parsed<unknown>): string => {
  if (parsed.ok) throw new Error(`expected a rejection, got ${String(parsed.value)}`);
  return parsed.reason;
};

describe('parseAmountCell', () => {
  it.each([
    ['1,23,456.50', 12_345_650n],
    ['123456.5', 12_345_650n],
    ['5,272.99', 527_299n],
    ['303.00', 30_300n],
    ['0', 0n],
    ['0.00', 0n],
    ['99,99,99,999.99', 99_999_999_999n], // 999,999,999 rupees and 99 paise
    ['  500.00  ', 50_000n],
    ['0.07', 7n],
  ])('%s -> %s paise', (input, paise) => {
    expect(value(parseAmountCell(input))).toBe(paise);
  });

  it.each([
    ['₹500', /currency symbols/],
    ['Rs. 500', /currency symbols/],
    ['1,500.00 Cr', /currency symbols or text/],
    ['1e5', /currency symbols or text/],
    ['1,234,567.00', /Indian digit grouping/], // Western grouping is never guessed
    ['12,34.00', /Indian digit grouping/],
    ['500.123', /more than 2 decimal places/],
    ['-5', /negative/],
    ['12.', /not a valid rupee amount/],
    ['', /is empty/],
    ['   ', /is empty/],
    ['99999999999999999999', /larger than any amount/],
  ])('rejects %j with a reason', (input, expected) => {
    expect(why(parseAmountCell(input))).toMatch(expected);
  });
});

describe('parseOptionalAmountCell', () => {
  it('treats a blank cell as absent and still validates a filled one', () => {
    expect(value(parseOptionalAmountCell(''))).toBeNull();
    expect(value(parseOptionalAmountCell('  '))).toBeNull();
    expect(value(parseOptionalAmountCell('2,979.00'))).toBe(297_900n);
    expect(why(parseOptionalAmountCell('abc'))).toMatch(/something other than digits/);
  });
});

describe('parseBalanceCell', () => {
  it('allows a negative balance (an overdrawn account) and a blank one', () => {
    expect(value(parseBalanceCell('-1,500.00'))).toBe(-150_000n);
    expect(value(parseBalanceCell('2,05,510.19'))).toBe(20_551_019n);
    expect(value(parseBalanceCell(''))).toBeNull();
  });

  it('still rejects text decorations', () => {
    expect(why(parseBalanceCell('1,500.00 Dr'))).toMatch(/something other than digits/);
  });
});
