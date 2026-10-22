import { createHash } from 'node:crypto';
import { uuidSchema } from '@ziro/core/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, deterministicUuid, importHash } from './identity.js';

describe('deterministicUuid', () => {
  const RUN = '00000000-0000-4000-8000-0000000000aa';

  it('is stable, so importing the same data twice yields the same ids', () => {
    expect(deterministicUuid(RUN, 'rzp_payment', 'pay_X')).toBe(
      deterministicUuid(RUN, 'rzp_payment', 'pay_X'),
    );
  });

  it('differs by run, record type and source reference', () => {
    const base = deterministicUuid(RUN, 'rzp_payment', 'pay_X');
    expect(
      deterministicUuid('00000000-0000-4000-8000-0000000000bb', 'rzp_payment', 'pay_X'),
    ).not.toBe(base);
    expect(deterministicUuid(RUN, 'rzp_refund', 'pay_X')).not.toBe(base);
    expect(deterministicUuid(RUN, 'rzp_payment', 'pay_Y')).not.toBe(base);
  });

  it('cannot be confused by a separator inside a field', () => {
    expect(deterministicUuid(RUN, 'a', 'b\0c')).not.toBe(deterministicUuid(RUN, 'a\0b', 'c'));
  });

  it('always passes strict UUID validation', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (type, ref) => {
        expect(uuidSchema.safeParse(deterministicUuid(RUN, type, ref)).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('canonicalJson / importHash', () => {
  it('ignores key order but keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: [2, 1] })).not.toBe(canonicalJson({ a: [1, 2] }));
  });

  it('writes null, booleans, strings and numbers exactly as JSON', () => {
    expect(canonicalJson({ n: null, t: true, s: 'q"x', i: -5, f: 0 })).toBe(
      '{"f":0,"i":-5,"n":null,"s":"q\\"x","t":true}',
    );
  });

  it('drops undefined values like JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('hashes to sha-256 hex, equal for reordered keys and different for any change', () => {
    const a = importHash({ id: 'pay_1', amount: 100, notes: [] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(importHash({ notes: [], amount: 100, id: 'pay_1' })).toBe(a);
    expect(importHash({ id: 'pay_1', amount: 101, notes: [] })).not.toBe(a);
    expect(a).toBe(
      createHash('sha256').update('{"amount":100,"id":"pay_1","notes":[]}').digest('hex'),
    );
  });

  it('hashes extras too: a field Razorpay adds later changes the hash, so a changed re-import is visible', () => {
    expect(importHash({ id: 'pay_1', new_field: 'x' })).not.toBe(importHash({ id: 'pay_1' }));
  });
});
