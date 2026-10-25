// Gemini's daily request quota resets at midnight Pacific time (ai.google.dev/gemini-api/docs/rate-limits),
// a zone with daylight saving. So "today" for the quota is the America/Los_Angeles calendar date, and the
// reset is the next local midnight, which is 07:00 or 08:00 UTC depending on the season. The offset is read
// from the platform's zone data (Intl), never hardcoded.
const ZONE = 'America/Los_Angeles';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Local {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localAt(ms: number): Local {
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.formatToParts(new Date(ms)).find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The Pacific calendar date of an instant, as YYYY-MM-DD. */
export function pacificDate(ms: number): string {
  const l = localAt(ms);
  return `${String(l.year).padStart(4, '0')}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
}

/** Pacific local time minus UTC at an instant, in ms (negative: -7 h in summer, -8 h in winter). */
export function pacificOffsetMs(ms: number): number {
  const l = localAt(ms);
  return (
    Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000
  );
}

/** The instant the Pacific date next changes: when the day's request quota resets. */
export function nextPacificMidnightMs(ms: number): number {
  const l = localAt(ms);
  const localMidnight = Date.UTC(l.year, l.month - 1, l.day + 1, 0, 0, 0);
  // The offset at the new midnight can differ from now (a clock change at 02:00 falls in between), so
  // refine the guess once from the offset found there.
  let instant = localMidnight - pacificOffsetMs(ms);
  instant = localMidnight - pacificOffsetMs(instant);
  return instant;
}
