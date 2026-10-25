import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelOutputSchema } from '../agent/output.js';
import { AGENT_TOOLS } from '../agent/tools/definitions.js';
import { GeminiSchemaError, toAnthropicJsonSchema, toGeminiJsonSchema } from './json-schema.js';

/** Every keyword used anywhere in a schema (property NAMES are not keywords). */
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywords(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      found.add(key);
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const child of Object.values(value as Record<string, unknown>)) keywords(child, found);
      } else if (key !== 'enum' && key !== 'required') {
        keywords(value, found);
      }
    }
  }
  return found;
}

const DOCUMENTED = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  '$ref',
]);

describe('toGeminiJsonSchema', () => {
  it('writes "a value or null" as a type list, because anyOf is outside the documented subset', () => {
    const schema = toGeminiJsonSchema(
      z.strictObject({ note: z.string().describe('a note').nullable() }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: { note: { type: ['string', 'null'], description: 'a note' } },
      required: ['note'],
      additionalProperties: false,
    });
  });

  it('keeps null in a nullable enum and nullable object', () => {
    const schema = toGeminiJsonSchema(
      z.strictObject({
        kind: z.enum(['a', 'b']).nullable(),
        inner: z.strictObject({ x: z.number() }).nullable(),
      }),
    ) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties['kind']).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
    expect(schema.properties['inner']).toMatchObject({
      type: ['object', 'null'],
      additionalProperties: false,
    });
  });

  it('drops what Gemini cannot express (pattern, string length, uuid format) and keeps bounds', () => {
    const schema = toGeminiJsonSchema(
      z.strictObject({
        id: z.uuid(),
        name: z.string().min(1).max(5),
        n: z.number().int().min(0).max(9),
        list: z.array(z.string()).min(1).max(3),
        on: z.iso.date(),
      }),
    ) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties['id']).toEqual({ type: 'string' });
    expect(schema.properties['name']).toEqual({ type: 'string' });
    expect(schema.properties['n']).toEqual({ type: 'integer', minimum: 0, maximum: 9 });
    expect(schema.properties['list']).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(schema.properties['on']).toEqual({ type: 'string', format: 'date' });
  });

  it('turns a literal into a one-value enum and closes open objects', () => {
    const schema = toGeminiJsonSchema(z.object({ v: z.literal('x') })) as {
      properties: Record<string, unknown>;
      additionalProperties: unknown;
    };
    expect(schema.properties['v']).toEqual({ type: 'string', enum: ['x'] });
    expect(schema.additionalProperties).toBe(false);
  });

  it('refuses a real union instead of silently sending something Gemini may reject', () => {
    // zod writes a union of two primitives as a type list, and a tagged union as oneOf
    expect(() => toGeminiJsonSchema(z.union([z.string(), z.number()]))).toThrow(GeminiSchemaError);
    const tagged = z.discriminatedUnion('k', [
      z.strictObject({ k: z.literal('a') }),
      z.strictObject({ k: z.literal('b') }),
    ]);
    expect(() => toGeminiJsonSchema(tagged)).toThrow(/"oneOf"/);
  });

  it('refuses a keyword it has never seen, and says where', () => {
    const schema = z.strictObject({ a: z.string().meta({ examples: ['x'] }) });
    expect(() => toGeminiJsonSchema(schema)).toThrow(/\$\.a: "examples"/);
  });

  it('does not mistake a property NAMED like a keyword for the keyword', () => {
    const schema = toGeminiJsonSchema(z.strictObject({ default: z.string(), pattern: z.string() }));
    expect(Object.keys((schema as { properties: object }).properties)).toEqual([
      'default',
      'pattern',
    ]);
  });

  it('converts every real schema the agent sends, using only documented keywords', () => {
    const everything: [string, z.ZodType][] = [
      ['model output', modelOutputSchema],
      ...AGENT_TOOLS.map((t) => [t.name, t.args] as [string, z.ZodType]),
    ];
    expect(everything.length).toBeGreaterThan(9);
    for (const [name, schema] of everything) {
      const used = keywords(toGeminiJsonSchema(schema));
      const unknown = [...used].filter((k) => !DOCUMENTED.has(k));
      expect(unknown, name).toEqual([]);
    }
  });
});

describe('toAnthropicJsonSchema', () => {
  it('closes objects and strips constraints the strict API rejects', () => {
    const schema = toAnthropicJsonSchema(
      z.object({ name: z.string().min(1).max(5), n: z.number().int().min(0) }),
    );
    expect(schema).toMatchObject({ additionalProperties: false });
    const used = keywords(schema);
    for (const gone of ['minLength', 'maxLength', 'minimum', 'pattern']) {
      expect(used.has(gone)).toBe(false);
    }
  });
});
