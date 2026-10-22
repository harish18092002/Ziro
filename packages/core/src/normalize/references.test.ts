import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeRef } from './references.js';

describe('normalizeRef', () => {
  it.each([
    [' ord-100001 ', 'ORD-100001'],
    ['ord-100001', 'ORD-100001'],
    ['ORD-100001', 'ORD-100001'],
    ['ord\u200B-100001', 'ORD-100001'], // zero-width space
    ['\uFEFFord-100001', 'ORD-100001'], // byte-order mark
    ['ＯＲＤ－１００００１', 'ORD-100001'], // full-width letters, digits and hyphen
    ['ord\u00A0 100001', 'ORD 100001'], // non-breaking space, then collapsed
    ['a  b\t c\n d', 'A B C D'],
    ['cust-00003', 'CUST-00003'],
    ['straße', 'STRASSE'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeRef(input)).toBe(expected);
  });

  it('keeps inner punctuation, which can be part of a key', () => {
    expect(normalizeRef('ord/100001_a.b')).toBe('ORD/100001_A.B');
  });

  it.each([[''], ['   '], ['\t\n'], ['\u200B\u200B']])('turns %j into null', (input) => {
    expect(normalizeRef(input)).toBeNull();
  });

  it('maps every spelling of the same reference to one key', () => {
    const spellings = ['ORD-7', 'ord-7', ' Ord-7 ', 'ORD\u200B-7', 'ｏｒｄ-７'];
    expect(new Set(spellings.map(normalizeRef))).toEqual(new Set(['ORD-7']));
  });

  it('is idempotent on any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (text) => {
        const once = normalizeRef(text);
        if (once === null) return;
        expect(normalizeRef(once)).toBe(once);
      }),
      { numRuns: 3000 },
    );
  });

  it('never leaves leading, trailing or doubled whitespace, or lower-case ASCII', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (text) => {
        const result = normalizeRef(text);
        if (result === null) return;
        expect(result).toBe(result.trim());
        expect(result).not.toMatch(/\s{2}/);
        expect(result).not.toMatch(/[a-z]/);
      }),
      { numRuns: 3000 },
    );
  });
});
