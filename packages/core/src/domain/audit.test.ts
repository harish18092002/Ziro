import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { auditEventSchema, bigintJsonReplacer, paiseSchema, sequenceIdSchema } from './index.js';
import { auditEventFixture } from './domain.fixtures.js';

function failures(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) =>
    i.code === 'unrecognized_keys' ? '(unknown key)' : i.path.join('.'),
  );
}

describe('AuditEvent', () => {
  it('parses an event and turns the sequence id into a bigint', () => {
    const event = auditEventSchema.parse(auditEventFixture());
    expect(event.id).toBe(42n);
    expect(event.actor).toBe('human');
  });

  it('accepts only the five actors of CLAUDE.md §4.7', () => {
    for (const actor of ['rule', 'agent', 'verifier', 'human', 'system']) {
      expect(failures(auditEventSchema, { ...auditEventFixture(), actor }), actor).toEqual([]);
    }
    for (const actor of ['llm', 'user', '']) {
      expect(failures(auditEventSchema, { ...auditEventFixture(), actor }), actor).toEqual([
        'actor',
      ]);
    }
  });

  it('allows system events with no run, and rejects an empty action', () => {
    expect(failures(auditEventSchema, { ...auditEventFixture(), runId: null })).toEqual([]);
    expect(failures(auditEventSchema, { ...auditEventFixture(), action: '' })).toEqual(['action']);
  });

  it('accepts nested JSON detail but not a raw bigint inside it', () => {
    const nested = { ...auditEventFixture(), detail: { links: [{ id: 'a' }], ok: true, n: null } };
    expect(failures(auditEventSchema, nested)).toEqual([]);
    expect(
      failures(auditEventSchema, { ...auditEventFixture(), detail: { residual: 5n } }),
    ).toEqual(['detail.residual']);
  });
});

describe('sequenceIdSchema', () => {
  it('accepts bigint, non-negative integer and digit strings', () => {
    expect(sequenceIdSchema.parse(7n)).toBe(7n);
    expect(sequenceIdSchema.parse(7)).toBe(7n);
    expect(sequenceIdSchema.parse('9007199254740993')).toBe(9007199254740993n);
    for (const bad of [-1, 1.5, '-1', '1.5', 'x'])
      expect(sequenceIdSchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

describe('bigintJsonReplacer', () => {
  it('writes paise as integer strings that paiseSchema reads back exactly', () => {
    const original = { amount: 9007199254740993n, nested: { fee: 5900n }, label: 'x', count: 3 };
    const json = JSON.stringify(original, bigintJsonReplacer);
    expect(json).toBe(
      '{"amount":"9007199254740993","nested":{"fee":"5900"},"label":"x","count":3}',
    );
    const back = JSON.parse(json) as { amount: string; nested: { fee: string } };
    expect(paiseSchema.parse(back.amount)).toBe(original.amount);
    expect(paiseSchema.parse(back.nested.fee)).toBe(original.nested.fee);
  });

  it('is needed: plain JSON.stringify refuses a bigint', () => {
    expect(() => JSON.stringify({ amount: 1n })).toThrow(TypeError);
  });
});
