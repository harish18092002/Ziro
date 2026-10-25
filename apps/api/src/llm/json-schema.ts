// Tools and the reply shape are written once, as zod. Each provider accepts a different subset of JSON
// Schema, so each gets its own sanitised copy. Nothing is lost by stripping a constraint: the same zod
// schema validates everything again on our side, which is the authoritative check.
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

const raw = (schema: z.ZodType): unknown =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

// --- Anthropic ------------------------------------------------------------------------------------
// Strict tool use and structured outputs accept a subset: every object closed (`additionalProperties:
// false`), no numeric or string length constraints, no defaults.

const ANTHROPIC_UNSUPPORTED = new Set([
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

function cleanForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanForAnthropic);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ANTHROPIC_UNSUPPORTED.has(key)) out[key] = cleanForAnthropic(value);
  }
  if (out['type'] === 'object' && out['additionalProperties'] === undefined) {
    out['additionalProperties'] = false;
  }
  return out;
}

/** A zod schema as the JSON Schema the Messages API accepts for tools and structured output. */
export function toAnthropicJsonSchema(schema: z.ZodType): JsonSchema {
  return cleanForAnthropic(raw(schema)) as JsonSchema;
}

// --- Gemini ---------------------------------------------------------------------------------------
// ai.google.dev/gemini-api/docs/structured-output lists the supported subset: the types, title and
// description, properties / required / additionalProperties, enum, format (date-time, date, time),
// minimum / maximum, items / prefixItems / minItems / maxItems, and `$ref: "#"`. A union (`anyOf`) is not
// in the list; the one shape we need, "a value or null", is written as a type list instead.
//
// This is an allow-list. A keyword that is neither kept nor deliberately dropped throws, so a schema that
// grows something Gemini may reject fails here, in a test, not as a 400 on the first live call.

const GEMINI_KEPT = new Set([
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

/** Constraints the docs say are accepted but not enforced, or that zod can say but Gemini cannot. */
const GEMINI_DROPPED = new Set([
  '$schema',
  'default',
  'pattern',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'uniqueItems',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'propertyNames',
]);

const GEMINI_FORMATS = new Set(['date-time', 'date', 'time']);

export class GeminiSchemaError extends Error {}

function isNullSchema(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as Record<string, unknown>)['type'] === 'null' &&
    Object.keys(node).length === 1
  );
}

function cleanForGemini(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => cleanForGemini(n, `${path}[${i}]`));
  if (typeof node !== 'object' || node === null) return node;
  const input = { ...(node as Record<string, unknown>) };

  // "A value or null": anyOf [X, {type: null}] becomes X with a type list.
  const union = input['anyOf'];
  if (Array.isArray(union)) {
    const [nulls, rest] = [union.filter(isNullSchema), union.filter((u) => !isNullSchema(u))];
    const only = rest[0] as Record<string, unknown> | undefined;
    if (nulls.length !== 1 || rest.length !== 1 || only === undefined) {
      throw new GeminiSchemaError(
        `${path}: a union other than "value or null" is outside Gemini's documented schema subset`,
      );
    }
    delete input['anyOf'];
    const type = only['type'];
    if (typeof type !== 'string') {
      throw new GeminiSchemaError(`${path}: a nullable value needs a single declared type`);
    }
    Object.assign(input, only, { type: [type, 'null'] });
    const values = only['enum'];
    if (Array.isArray(values)) input['enum'] = [...(values as unknown[]), null];
  }

  // A literal is a one-value enum.
  if ('const' in input) {
    input['enum'] = [input['const']];
    delete input['const'];
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (GEMINI_DROPPED.has(key)) continue;
    if (!GEMINI_KEPT.has(key)) {
      throw new GeminiSchemaError(`${path}: "${key}" is outside Gemini's documented schema subset`);
    }
    if (key === 'format' && !GEMINI_FORMATS.has(String(value))) continue;
    if (key === 'type' && Array.isArray(value)) {
      // The docs show a type list only as [X, "null"]; a list of two real types is not documented.
      const real = value.filter((t) => t !== 'null');
      if (real.length !== 1 || value.length !== 2) {
        throw new GeminiSchemaError(
          `${path}: a type list other than [type, "null"] is outside Gemini's documented schema subset`,
        );
      }
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          cleanForGemini(child, `${path}.${name}`),
        ]),
      );
    } else if (key === 'items' || key === 'prefixItems' || key === 'additionalProperties') {
      out[key] = cleanForGemini(value, `${path}.${key}`);
    } else {
      out[key] = value;
    }
  }
  if (out['type'] === 'object' && out['additionalProperties'] === undefined) {
    out['additionalProperties'] = false;
  }
  return out;
}

/** A zod schema as the JSON Schema Gemini accepts for function parameters and structured output. */
export function toGeminiJsonSchema(schema: z.ZodType): JsonSchema {
  return cleanForGemini(raw(schema), '$') as JsonSchema;
}
