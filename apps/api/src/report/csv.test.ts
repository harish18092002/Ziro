import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, plainRupees, toCsv } from './csv.js';

describe('csvCell', () => {
  it('leaves plain text, numbers and bigints alone, and empties null and undefined', () => {
    expect(csvCell('ORD-1001')).toBe('ORD-1001');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-47300n)).toBe('-47300');
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@HYPERLINK("http://x")', '\t=1', '\r=1'])(
    'defuses a text cell that a spreadsheet would run as a formula: %j',
    (text) => {
      const cell = csvCell(text);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('quotes cells with commas, quotes and line breaks, doubling the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('defuses and quotes together', () => {
    expect(csvCell('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`);
  });

  it('never lets any text begin with a formula character once written', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (text) => {
        const cell = csvCell(text);
        const inner = cell.startsWith('"') ? cell.slice(1) : cell;
        expect(/^[=+\-@\t\r]/.test(inner)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips through a CSV reader for any text', () => {
    const read = (line: string): string => {
      // Enough of RFC 4180 for one cell.
      const body = line.startsWith('"') ? line.slice(1, -1).replace(/""/g, '"') : line;
      return body;
    };
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        const unsafe = /^[=+\-@\t\r]/.test(text);
        expect(read(csvCell(text))).toBe(unsafe ? `'${text}` : text);
      }),
      { numRuns: 300 },
    );
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF and ends with one', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, 'x'],
          [2, 'y,z'],
        ],
      ),
    ).toBe('a,b\r\n1,x\r\n2,"y,z"\r\n');
    expect(csvRow(['=x', 5])).toBe("'=x,5");
  });
});

describe('plainRupees', () => {
  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [100n, '1.00'],
    [1234550n, '12345.50'],
    [-47300n, '-473.00'],
    [-5n, '-0.05'],
    [9_007_199_254_740_993n, '90071992547409.93'],
  ])('%s paise is %s', (paise, text) => {
    expect(plainRupees(paise)).toBe(text);
  });
});
