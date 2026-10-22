/**
 * A JSON writer that exists for two reasons JSON.stringify cannot meet:
 *  1. money is a bigint, and JSON.stringify throws on bigint;
 *  2. a float must never reach an output file (CLAUDE.md §4.1), so any non-integer number throws.
 * Keys are written in insertion order, so output is stable by construction.
 */
export type Json =
  null | boolean | number | bigint | string | readonly Json[] | { readonly [key: string]: Json };

export function stringifyJson(value: Json, indent: number, depth = 0): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isSafeInteger(value))
        throw new TypeError(`refusing to write non-integer number ${value}`);
      return String(value);
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }

  const pretty = indent > 0;
  const inner = pretty ? `\n${' '.repeat(indent * (depth + 1))}` : '';
  const outer = pretty ? `\n${' '.repeat(indent * depth)}` : '';
  const colon = pretty ? ': ' : ':';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = (value as readonly Json[]).map((item) => stringifyJson(item, indent, depth + 1));
    return `[${inner}${parts.join(`,${inner}`)}${outer}]`;
  }
  const entries = Object.entries(value as { readonly [key: string]: Json });
  if (entries.length === 0) return '{}';
  const parts = entries.map(
    ([key, item]) => `${JSON.stringify(key)}${colon}${stringifyJson(item, indent, depth + 1)}`,
  );
  return `{${inner}${parts.join(`,${inner}`)}${outer}}`;
}

/** A Razorpay-style `{ entity: "collection", count, items }` document, produced item by item. */
export function* collectionChunks(
  items: Iterable<Json>,
  count: number,
  indent: 0 | 2,
): Generator<string> {
  if (indent === 0) {
    yield `{"entity":"collection","count":${count},"items":[\n`;
    let first = true;
    for (const item of items) {
      yield `${first ? '' : ',\n'}${stringifyJson(item, 0)}`;
      first = false;
    }
    yield '\n]}\n';
    return;
  }
  yield `{\n  "entity": "collection",\n  "count": ${count},\n  "items": [`;
  let first = true;
  for (const item of items) {
    yield `${first ? '\n' : ',\n'}    ${stringifyJson(item, 2, 2)}`;
    first = false;
  }
  yield count === 0 ? ']\n}\n' : '\n  ]\n}\n';
}
