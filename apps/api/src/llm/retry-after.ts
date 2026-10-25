/**
 * How long the server asked us to wait. `retry-after-ms` (milliseconds) wins over `retry-after`
 * (seconds, or an HTTP date). Null when it said nothing usable.
 */
export function retryAfterMsOf(
  headers: { get(name: string): string | null } | undefined,
  now = Date.now(),
): number | null {
  if (headers === undefined || typeof headers.get !== 'function') return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms) && ms >= 0)
    return Math.round(ms);
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
