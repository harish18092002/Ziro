import { collectionEnvelopeSchema } from '@ziro/core/razorpay';
import { istDayBounds } from '@ziro/core/time';
import type { z } from 'zod';
import { RazorpayConfigError, RazorpayResponseError } from './errors.js';
import type { RawEntry } from './mappers.js';
import type { DateRange } from './source.js';

/** First few problems of a failed parse, naming fields only, never echoing values. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(item)'}: ${i.message}`)
    .join('; ');
}

/** Validates each raw item against the tolerant ingest schema, keeping the original untouched. */
export function parseEntries<S extends z.ZodType>(
  items: readonly unknown[],
  schema: S,
  entity: string,
): RawEntry<z.infer<S>>[] {
  return items.map((original, index) => {
    const result = schema.safeParse(original);
    if (!result.success) {
      throw new RazorpayResponseError(
        `${entity} item #${index} is not usable: ${describeIssues(result.error)}`,
      );
    }
    return { parsed: result.data, original };
  });
}

/** The `{ entity: "collection", count, items }` wrapper of a list response. */
export function parseCollection(body: unknown, entity: string): unknown[] {
  const result = collectionEnvelopeSchema.safeParse(body);
  if (!result.success) {
    throw new RazorpayResponseError(
      `${entity} response is not a collection: ${describeIssues(result.error)}`,
    );
  }
  return result.data.items;
}

/** Keeps the first entry for each key: pages fetched with count/skip can overlap if data changes. */
export function dedupeBy<T>(
  entries: readonly RawEntry<T>[],
  key: (item: T) => string,
): RawEntry<T>[] {
  const seen = new Set<string>();
  return entries.filter(({ parsed }) => {
    const k = key(parsed);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const dedupeById = <T extends { readonly id: string }>(
  entries: readonly RawEntry<T>[],
): RawEntry<T>[] => dedupeBy(entries, (item) => item.id);

export interface EpochRange {
  readonly fromEpoch: number;
  readonly toEpoch: number;
}

/** Inclusive IST business dates -> inclusive Unix-second bounds. */
export function epochRange(range: DateRange): EpochRange {
  if (range.from > range.to)
    throw new RazorpayConfigError(`range starts after it ends: ${range.from} > ${range.to}`);
  return { fromEpoch: istDayBounds(range.from).fromEpoch, toEpoch: istDayBounds(range.to).toEpoch };
}

export const inRange = (epoch: number, { fromEpoch, toEpoch }: EpochRange): boolean =>
  epoch >= fromEpoch && epoch <= toEpoch;
