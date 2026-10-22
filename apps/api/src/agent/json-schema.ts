// Anthropic's strict tool use and structured outputs accept a subset of JSON Schema: every object
// closed (`additionalProperties: false`), no numeric or string length constraints, no defaults. Zod
// emits all of those, so the schema sent to the API is a sanitised copy. The constraints are not lost:
// the same zod schema validates everything again on our side, which is the authoritative check.
import { z } from 'zod';

const UNSUPPORTED = new Set([
  '$schema',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!UNSUPPORTED.has(key)) out[key] = clean(value);
  }
  if (out['type'] === 'object' && out['additionalProperties'] === undefined) {
    out['additionalProperties'] = false;
  }
  return out;
}

export type JsonSchema = Record<string, unknown>;

/** A zod schema as the JSON Schema the Messages API will accept for tools and structured output. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  return clean(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as JsonSchema;
}
