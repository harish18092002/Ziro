import { describe, expect, it } from 'vitest';
import { parseCsv } from './datagen.fixtures.js';
import { csvRow } from './render/csv.js';
import { collectionChunks, stringifyJson } from './render/json.js';
import { Rng } from './rng.js';
import { degradeUtr } from './world/bank.js';

describe('stringifyJson', () => {
  it('writes bigint as an unquoted integer, which JSON.stringify cannot do', () => {
    expect(stringifyJson({ amount: 9_007_199_254_740_993n }, 0)).toBe(
      '{"amount":9007199254740993}',
    );
  });

  it('refuses a non-integer number: a float must never reach an output file', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => stringifyJson({ x: bad }, 0), String(bad)).toThrow(TypeError);
    }
  });

  it('keeps key order, writes null/bool/[]/{} and escapes strings', () => {
    expect(stringifyJson({ b: 1, a: [], c: {}, d: null, e: true, f: 'q"uote\n' }, 0)).toBe(
      '{"b":1,"a":[],"c":{},"d":null,"e":true,"f":"q\\"uote\\n"}',
    );
  });

  it('pretty-prints with the given indent and parses back to the same value', () => {
    const value = { a: [1, 2, { b: 'x' }], c: { d: null } };
    const text = stringifyJson(value, 2);
    expect(text).toBe(
      '{\n  "a": [\n    1,\n    2,\n    {\n      "b": "x"\n    }\n  ],\n  "c": {\n    "d": null\n  }\n}',
    );
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('collectionChunks', () => {
  const doc = (items: object[], indent: 0 | 2): unknown =>
    JSON.parse([...collectionChunks(items as never[], items.length, indent)].join(''));

  it('writes a Razorpay-style collection in both pretty and compact form', () => {
    for (const indent of [0, 2] as const) {
      expect(doc([{ id: 'a' }, { id: 'b' }], indent)).toEqual({
        entity: 'collection',
        count: 2,
        items: [{ id: 'a' }, { id: 'b' }],
      });
    }
  });

  it('handles an empty collection', () => {
    for (const indent of [0, 2] as const)
      expect(doc([], indent)).toEqual({ entity: 'collection', count: 0, items: [] });
  });
});

describe('csvRow', () => {
  it('quotes only when needed, escapes quotes, and ends in LF', () => {
    expect(csvRow(['a', 'b c', ''])).toBe('a,b c,\n');
    expect(csvRow(['1,23,456.50', 'say "hi"', 'two\nlines'])).toBe(
      '"1,23,456.50","say ""hi""","two\nlines"\n',
    );
  });

  it('round-trips awkward cells through the test parser', () => {
    const rows = [
      ['x', 'a,b', 'q"q'],
      ['', 'line1\nline2', ' spaced '],
      ['₹1,00,000.00', 'plain', ''],
    ];
    const text = rows.map(csvRow).join('');
    expect(parseCsv(text)).toEqual(rows);
  });
});

describe('degradeUtr', () => {
  const UTR = 'UTIBN34889755412';

  it('missing yields nothing', () => {
    expect(degradeUtr(Rng.fromSeed(1), UTR, 'missing')).toBeNull();
  });

  it('truncated is a proper prefix, 3 to 6 characters short', () => {
    for (let seed = 0; seed < 200; seed++) {
      const out = degradeUtr(Rng.fromSeed(seed), UTR, 'truncated') as string;
      expect(UTR.startsWith(out)).toBe(true);
      expect(UTR.length - out.length).toBeGreaterThanOrEqual(3);
      expect(UTR.length - out.length).toBeLessThanOrEqual(6);
    }
  });

  it('split inserts exactly one space and loses nothing else', () => {
    for (let seed = 0; seed < 200; seed++) {
      const out = degradeUtr(Rng.fromSeed(seed), UTR, 'split') as string;
      expect(out.split(' ')).toHaveLength(2);
      expect(out.replace(' ', '')).toBe(UTR);
    }
  });

  it('garbled always differs from the original, keeps its length, and changes one or two characters', () => {
    for (const utr of [
      UTR,
      'HDFCR58112266337',
      'ICICN12345678901',
      'SBINN22222222222',
      'KKBKN23232323232',
    ]) {
      for (let seed = 0; seed < 200; seed++) {
        const out = degradeUtr(Rng.fromSeed(seed), utr, 'garbled') as string;
        expect(out).not.toBe(utr);
        expect(out).toHaveLength(utr.length);
        const changed = [...out].filter((ch, i) => ch !== utr[i]).length;
        expect(changed).toBeGreaterThanOrEqual(1);
        expect(changed).toBeLessThanOrEqual(2);
      }
    }
  });
});
