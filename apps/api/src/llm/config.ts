// Parsers for the settings that describe the model layer: which models to try and in what order, what the
// free tier allows, and what the paid list price is. Pure, and they never echo the text they were given
// (the environment can hold keys, and EnvValidationError promises not to print values): a problem is
// described by its position and what was expected.
//
// No model id and no number appears in this file. Ids come from LLM_CHAIN, request limits from
// GEMINI_LIMITS (copied by the author from aistudio.google.com/rate-limit), prices from LLM_PRICES.
import { z } from 'zod';

export const PROVIDER_NAMES = ['gemini', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

// --- LLM_CHAIN ---------------------------------------------------------------------------------------

/** One model to try: a provider and the model id as that provider spells it. */
export interface ChainEntry {
  readonly provider: ProviderName;
  readonly model: string;
  /** `provider:model`, the key used for prices, breakers and the status page. */
  readonly id: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `gemini:model-a,gemini:model-b,anthropic:model-c`, in the order they are tried. Blank means none. */
export function parseChain(raw: string | undefined): Parsed<readonly ChainEntry[]> {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: [] };
  const entries: ChainEntry[] = [];
  const parts = raw.split(',');
  for (const [i, part] of parts.entries()) {
    const at = `entry ${i + 1}`;
    const text = part.trim();
    if (text === '') return fail(`${at} is empty (a stray comma?)`);
    const colon = text.indexOf(':');
    if (colon <= 0 || colon === text.length - 1) {
      return fail(`${at} must look like provider:model`);
    }
    const provider = text.slice(0, colon);
    const model = text.slice(colon + 1);
    if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
      return fail(
        `${at}: the provider must be ${PROVIDER_NAMES.map((p) => `"${p}"`).join(' or ')}`,
      );
    }
    if (!MODEL_ID.test(model))
      return fail(`${at}: the model id has characters a model id never has`);
    const id = `${provider}:${model}`;
    if (entries.some((e) => e.id === id)) return fail(`${at} repeats an earlier entry`);
    entries.push({ provider: provider as ProviderName, model, id });
  }
  return { ok: true, value: entries };
}

// --- GEMINI_LIMITS -----------------------------------------------------------------------------------

/** What the free tier allows one model, as the author read it off the rate-limit page. */
export interface ModelLimits {
  /** Requests per minute. */
  readonly rpm: number;
  /** Requests per day; the day ends at midnight Pacific. */
  readonly rpd: number;
  /** Tokens per minute. Kept so the status page can show it; the limiter counts requests, not tokens. */
  readonly tpm?: number;
}

const limitInt = z.number().int().min(1).max(100_000_000);

const limitsSchema = z.record(
  z.string().regex(MODEL_ID),
  z.strictObject({ rpm: limitInt, rpd: limitInt, tpm: limitInt.optional() }),
);

/** `{"<model>": {"rpm": N, "rpd": N, "tpm": N}}`. Blank means no limits are known. */
export function parseLimits(
  raw: string | undefined,
): Parsed<Readonly<Record<string, ModelLimits>>> {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: {} };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail('is not valid JSON');
  }
  const parsed = limitsSchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      'must be an object of model id to {"rpm": whole number, "rpd": whole number, optional "tpm"}',
    );
  }
  const value: Record<string, ModelLimits> = {};
  for (const [model, l] of Object.entries(parsed.data)) {
    value[model] =
      l.tpm === undefined ? { rpm: l.rpm, rpd: l.rpd } : { rpm: l.rpm, rpd: l.rpd, tpm: l.tpm };
  }
  return { ok: true, value };
}

// --- LLM_PRICES --------------------------------------------------------------------------------------

/** Paid list price in micro-USD per million tokens ($0.10 per million is 100_000). */
export interface Rates {
  readonly input: bigint;
  readonly output: bigint;
  /** Absent when the author gave none; a cache read is then priced as input, which can only overstate. */
  readonly cacheRead?: bigint;
  readonly cacheWrite?: bigint;
}

const DECIMAL = /^\d{1,6}(\.\d{1,6})?$/;

/** "0.30" to 300000n. Strings and plain numbers are accepted; exponent notation is not. */
function microUsd(value: unknown): bigint | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !DECIMAL.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

const priceField = z.union([z.string(), z.number()]);
const pricesSchema = z.record(
  z.string(),
  z.strictObject({
    input: priceField,
    output: priceField,
    cacheRead: priceField.optional(),
    cacheWrite: priceField.optional(),
  }),
);

/**
 * `{"<provider>:<model>": {"input": "0.30", "output": "2.50"}}`, USD per million tokens, copied by the
 * author from the provider's price page. Blank means no prices: an estimate is then "n/a" and a paid
 * provider stays off, because its spend could not be counted.
 */
export function parsePrices(raw: string | undefined): Parsed<Readonly<Record<string, Rates>>> {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: {} };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail('is not valid JSON');
  }
  const parsed = pricesSchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      'must be an object of provider:model to {"input": USD, "output": USD, optional "cacheRead", "cacheWrite"} per million tokens',
    );
  }
  const value: Record<string, Rates> = {};
  for (const [id, p] of Object.entries(parsed.data)) {
    const chain = parseChain(id);
    if (!chain.ok || chain.value.length !== 1) return fail('a key must look like provider:model');
    const input = microUsd(p.input);
    const output = microUsd(p.output);
    const cacheRead = p.cacheRead === undefined ? undefined : microUsd(p.cacheRead);
    const cacheWrite = p.cacheWrite === undefined ? undefined : microUsd(p.cacheWrite);
    if (input === null || output === null || cacheRead === null || cacheWrite === null) {
      return fail('a price must be a plain decimal such as 0.30 (no exponent, at most 6 decimals)');
    }
    value[id] = {
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    };
  }
  return { ok: true, value };
}
