import { createHash } from 'node:crypto';

/**
 * A stable UUID for a record: the same run + record type + source reference always give the same
 * id, so importing the same data twice is idempotent. Laid out as an RFC 4122 version-5-style UUID
 * (version and variant bits set) so it passes strict UUID validation.
 */
export function deterministicUuid(runId: string, recordType: string, sourceRef: string): string {
  // Length-prefixed, so no value in any field can be mistaken for the boundary between two fields.
  const part = (text: string): string => `${text.length}:${text}`;
  const bytes = createHash('sha256')
    .update(part(runId) + part(recordType) + part(sourceRef))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** JSON with every object's keys sorted, so equal data always serialises to equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('cannot canonicalise a non-JSON value');
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/** sha-256 of the canonical form of the record exactly as received: detects a changed re-import. */
export function importHash(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex');
}
