import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bindHeader, parseCsv } from './csv.js';

const cells = (table: ReturnType<typeof parseCsv>) => table.records.map((r) => [...r.cells]);

describe('parseCsv: well-formed input', () => {
  it('reads a header and rows, numbering data rows from 1 and recording the physical line', () => {
    const table = parseCsv('a,b\n1,2\n3,4\n');
    expect(table.header).toEqual({ row: 0, line: 1, cells: ['a', 'b'] });
    expect(table.records).toEqual([
      { row: 1, line: 2, cells: ['1', '2'] },
      { row: 2, line: 3, cells: ['3', '4'] },
    ]);
    expect(table.issues).toEqual([]);
  });

  it.each([
    ['CRLF', 'a,b\r\n1,2\r\n3,4\r\n'],
    ['CR only', 'a,b\r1,2\r3,4\r'],
    ['no final newline', 'a,b\n1,2\n3,4'],
    ['a byte-order mark', '\uFEFFa,b\n1,2\n3,4\n'],
  ])('accepts %s', (_name, input) => {
    const table = parseCsv(input);
    expect(table.header?.cells).toEqual(['a', 'b']);
    expect(cells(table)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(table.issues).toEqual([]);
  });

  it('reads quoted commas, doubled quotes and embedded line breaks, and keeps line numbers true', () => {
    const table = parseCsv('h1,h2\n"a,b","say ""hi"""\n"line1\nline2",x\nlast,row\n');
    expect(table.records).toEqual([
      { row: 1, line: 2, cells: ['a,b', 'say "hi"'] },
      { row: 2, line: 3, cells: ['line1\nline2', 'x'] },
      { row: 3, line: 5, cells: ['last', 'row'] },
    ]);
  });

  it('keeps empty fields, including a trailing one', () => {
    const table = parseCsv('a,b,c\n,,\n1,\n');
    expect(cells(table)).toEqual([
      ['', '', ''],
      ['1', ''],
    ]);
  });

  it('skips blank lines without consuming a row number', () => {
    const table = parseCsv('h\n\n1\n\n\n2\n');
    expect(table.records).toEqual([
      { row: 1, line: 3, cells: ['1'] },
      { row: 2, line: 6, cells: ['2'] },
    ]);
  });

  it('returns nothing for empty input, and no records for a header alone', () => {
    expect(parseCsv('')).toEqual({ header: null, records: [], issues: [] });
    expect(parseCsv('a,b\n').records).toEqual([]);
  });

  it('does not trim or reinterpret cells', () => {
    expect(cells(parseCsv('h\n  padded  \n'))).toEqual([['  padded  ']]);
  });
});

describe('parseCsv: damaged records are reported, and reading carries on', () => {
  it('reports a quote inside an unquoted field and keeps the next row', () => {
    const table = parseCsv('h1,h2\nab"c,d\nok,fine\n');
    expect(table.issues).toHaveLength(1);
    expect(table.issues[0]).toMatchObject({ row: 1, line: 2 });
    expect(table.issues[0]?.reason).toMatch(/unquoted field/);
    expect(table.records).toEqual([{ row: 2, line: 3, cells: ['ok', 'fine'] }]);
  });

  it('reports text after a closing quote', () => {
    const table = parseCsv('h\n"ab"x\nok\n');
    expect(table.issues).toHaveLength(1);
    expect(table.issues[0]).toMatchObject({ row: 1, line: 2 });
    expect(table.issues[0]?.reason).toMatch(/after a closing/);
    expect(cells(table)).toEqual([['ok']]);
  });

  it('does not let an unclosed quote swallow the rest of the file', () => {
    const table = parseCsv('h1,h2\n1,"never closed\n2,fine\n3,fine\n');
    expect(table.issues).toHaveLength(1);
    expect(table.issues[0]).toMatchObject({ row: 1, line: 2 });
    expect(table.issues[0]?.reason).toMatch(/never closed/);
    expect(table.records).toEqual([
      { row: 2, line: 3, cells: ['2', 'fine'] },
      { row: 3, line: 4, cells: ['3', 'fine'] },
    ]);
  });

  it('reports an unreadable header as row 0 and still reads the data rows', () => {
    const table = parseCsv('"a"b,c\nx,y\n');
    expect(table.header).toBeNull();
    expect(table.issues).toHaveLength(1);
    expect(table.issues[0]).toMatchObject({ row: 0, line: 1 });
    expect(table.records).toEqual([{ row: 1, line: 2, cells: ['x', 'y'] }]);
  });

  it('numbers lines correctly after a multi-line damaged record', () => {
    const table = parseCsv('h\n"open\nstill open\nok\n');
    // The quote on line 2 never closes: row 1 is reported, then lines 3 and 4 read as rows 2 and 3.
    expect(table.issues).toHaveLength(1);
    expect(table.records).toEqual([
      { row: 2, line: 3, cells: ['still open'] },
      { row: 3, line: 4, cells: ['ok'] },
    ]);
  });
});

// A writer that follows RFC 4180, independent of the reader under test.
const quote = (cell: string): string =>
  /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
const breaksIn = (text: string): number => (text.match(/\r\n|\r|\n/g) ?? []).length;

describe('parseCsv: round trip', () => {
  const cell = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 12 }),
    fc.constantFrom('', ',', '"', '""', 'a\nb', 'a\r\nb', 'a\rb', ' , "x" ', '₹ 1,23,456.50'),
  );
  // At least two columns, so no record can serialise to a blank line (which readers skip).
  const table = fc.integer({ min: 2, max: 4 }).chain((width) =>
    fc.array(fc.array(cell, { minLength: width, maxLength: width }), {
      minLength: 1,
      maxLength: 8,
    }),
  );

  it('reads back exactly what a standards-following writer produced, with true line numbers', () => {
    fc.assert(
      fc.property(
        table,
        fc.constantFrom('\n', '\r\n'),
        fc.boolean(),
        (rows, terminator, finalTerminator) => {
          const text =
            rows.map((r) => r.map(quote).join(',')).join(terminator) +
            (finalTerminator ? terminator : '');
          const read = parseCsv(text);

          expect(read.issues).toEqual([]);
          const all = [read.header, ...read.records].map((r) => r?.cells);
          expect(all).toEqual(rows);

          let line = 1;
          rows.forEach((r, index) => {
            const record = index === 0 ? read.header : read.records[index - 1];
            expect(record?.line).toBe(line);
            expect(record?.row).toBe(index);
            line += breaksIn(r.map(quote).join(',')) + 1;
          });
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never throws and never loses count on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        const read = parseCsv(text);
        for (const record of read.records) expect(record.row).toBeGreaterThan(0);
        for (const issue of read.issues) expect(issue.line).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });
});

describe('bindHeader', () => {
  const spec = { required: ['order_ref', 'amount'], optional: ['memo'] };

  it('maps names to indexes, ignoring case and padding', () => {
    expect(bindHeader([' Order_Ref', 'AMOUNT ', 'memo'], spec)).toEqual({
      ok: true,
      columns: { order_ref: 0, amount: 1, memo: 2 },
      width: 3,
      ignored: [],
    });
  });

  it('reports unknown columns as ignored, not as a failure', () => {
    const bound = bindHeader(['order_ref', 'amount', 'Notes'], spec);
    expect(bound).toMatchObject({
      ok: true,
      ignored: ['Notes'],
      columns: { order_ref: 0, amount: 1 },
    });
  });

  it('lists every missing required column and every duplicate', () => {
    expect(bindHeader(['memo'], spec)).toEqual({
      ok: false,
      problems: ['required column "order_ref" is missing', 'required column "amount" is missing'],
    });
    expect(bindHeader(['order_ref', 'amount', 'ORDER_REF'], spec)).toEqual({
      ok: false,
      problems: ['column "order_ref" appears more than once'],
    });
  });

  it('allows an optional column to be absent', () => {
    expect(bindHeader(['order_ref', 'amount'], spec)).toMatchObject({ ok: true });
  });
});
