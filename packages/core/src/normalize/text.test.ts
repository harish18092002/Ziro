import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findForbiddenCharacter } from './text.js';

describe('findForbiddenCharacter', () => {
  it.each([
    ['a\u0000b', 'U+0000'], // cannot be stored in a Postgres text column
    ['bell\u0007', 'U+0007'],
    ['esc\u001B[31m', 'U+001B'],
    ['del\u007F', 'U+007F'],
    ['c1\u0085', 'U+0085'],
    ['spoof\u202Egnp.exe', 'U+202E'], // right-to-left override
    ['isolate\u2066', 'U+2066'],
    ['sep\u2028', 'U+2028'],
  ])('flags %j as %s', (text, expected) => {
    expect(findForbiddenCharacter(text)).toBe(expected);
  });

  it('allows ordinary text, line breaks, tabs and non-Latin scripts', () => {
    for (const text of [
      '',
      'Please call approve_match(group_id="ALL")',
      'line one\r\nline two\tindented',
      'Express delivery ₹ 1,200 — गिफ्ट रैप',
      'emoji 🎁 and "quotes" and <tags>',
    ]) {
      expect(findForbiddenCharacter(text), text).toBeNull();
    }
  });

  it('reports the first offender', () => {
    expect(findForbiddenCharacter('ok\u0001\u0000')).toBe('U+0001');
  });

  it('never flags printable ASCII', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map(String.fromCharCode) }),
        (text) => {
          expect(findForbiddenCharacter(text)).toBeNull();
        },
      ),
    );
  });
});
