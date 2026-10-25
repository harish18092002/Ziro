import { describe, expect, it } from 'vitest';
import { rupeesToPaise, showPaise } from './pay-math';

describe('rupeesToPaise', () => {
  it.each([
    ['500', 50_000],
    ['1', 100],
    ['1.00', 100],
    ['99.99', 9_999],
    ['99.9', 9_990],
    ['0.10', null],
    ['10000', 1_000_000],
    ['10,000', 1_000_000],
    ['1,234.5', 123_450],
    ['  250 ', 25_000],
  ])('%j is %j', (text, paise) => {
    expect(rupeesToPaise(text)).toBe(paise);
  });

  it.each([
    '',
    'abc',
    '0',
    '0.99',
    '10000.01',
    '100000',
    '1.234',
    '-5',
    '1e3',
    '5.',
    '.5',
    '₹500',
    '50 0',
  ])('refuses %j', (text) => {
    expect(rupeesToPaise(text)).toBeNull();
  });

  it('never goes through a float: 0.07 and 1.15 come out exact', () => {
    expect(rupeesToPaise('1.15')).toBe(115);
    expect(rupeesToPaise('2.07')).toBe(207);
    expect(rupeesToPaise('19.99')).toBe(1_999);
  });
});

describe('showPaise', () => {
  it.each([
    [52_730, '₹527.30'],
    [100, '₹1.00'],
    [1_000_000, '₹10,000.00'],
    [5, '₹0.05'],
  ])('%s shows as %s', (paise, shown) => {
    expect(showPaise(paise)).toBe(shown);
  });
});
