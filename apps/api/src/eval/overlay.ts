// The injection overlay, applied to a COPY of a generated dataset. Payloads from the generator's own
// catalogue are appended to the ledger memo or bank narration of records that sit in exceptions an agent
// will examine. Appending cannot change the right answer (truth is untouched), and each placement is
// checked not to change what the RULES do: the matcher runs on the edited copy and must give the same
// groups and the same exceptions, or that placement is dropped and another is planned. A narration carries
// the UTR the rules read, which is why the check is not optional.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '@ziro/core/normalize';
import { runMatcher } from '@ziro/core/matcher';
import type { PresetName } from '@ziro/datagen';
import { type OverlayItem, type OverlaySlot, planOverlay } from '@ziro/evals';
import { skipReason } from '../agent/triage.js';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';

const SEPARATOR = ' | ';

/** CSV text for a table of cells: quotes only where the content needs it, as the generator does. */
function toCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  eol: string,
): string {
  const cell = (c: string): string => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join(eol) + eol;
}

/** Appends payloads to the memo / narration cells of the named records, in place, in one CSV file. */
function editCsv(
  path: string,
  column: string,
  rowKey: (record: { row: number; cells: readonly string[] }, header: readonly string[]) => string,
  payloads: ReadonlyMap<string, string>,
): void {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const table = parseCsv(raw);
  if (table.header === null || table.issues.length > 0) {
    throw new Error(`${path} should be readable: ${table.issues[0]?.reason ?? 'no header'}`);
  }
  const header = [...table.header.cells];
  const at = header.indexOf(column);
  if (at < 0) throw new Error(`${path} has no "${column}" column`);
  const rows = table.records.map((record) => {
    const cells = [...record.cells];
    while (cells.length < header.length) cells.push('');
    const text = payloads.get(rowKey(record, header));
    if (text !== undefined) cells[at] = cells[at] === '' ? text : `${cells[at]}${SEPARATOR}${text}`;
    return cells;
  });
  writeFileSync(path, toCsv(header, rows, eol));
}

/** Writes `items` into a copy of `sourceDir` at `targetDir`. Pure file work; nothing is run. */
export function writeOverlayCopy(
  sourceDir: string,
  targetDir: string,
  items: readonly OverlayItem[],
): void {
  cpSync(sourceDir, targetDir, { recursive: true });
  const ledger = new Map(
    items
      .filter((i) => i.type === 'ledger_entry')
      .map((i) => [i.key.slice('ledger_entry:'.length), i.text]),
  );
  const bank = new Map(
    items
      .filter((i) => i.type === 'bank_line')
      .map((i) => [i.key.slice('bank_line:'.length), i.text]),
  );
  if (ledger.size > 0) {
    editCsv(
      join(targetDir, 'ledger.csv'),
      'memo',
      (record, header) => record.cells[header.indexOf('order_ref')] ?? '',
      ledger,
    );
  }
  if (bank.size > 0) {
    editCsv(
      join(targetDir, 'bank_statement.csv'),
      'narration',
      (record) => `row-${record.row}`,
      bank,
    );
  }
}

/** What the rules did, reduced to something two runs can be compared on. */
export function signature(
  out: ReturnType<typeof runMatcher>,
  keyOf: (id: string) => string,
): string {
  const groups = out.groups
    .map(
      (g) =>
        `${g.kind}:${g.members
          .map((m) => keyOf(m.recordId))
          .sort()
          .join('+')}:${g.reasonCode ?? ''}`,
    )
    .sort();
  const exceptions = out.exceptions
    .map(
      (e) =>
        `${keyOf(e.subject.recordId)}:${e.cause}:${e.candidates
          .map((c) => keyOf(c.recordId))
          .sort()
          .join('+')}`,
    )
    .sort();
  return JSON.stringify({ groups, exceptions });
}

export interface OverlayPlan {
  /** The edited copy; remove it with `cleanup`. */
  readonly dir: string;
  readonly items: readonly OverlayItem[];
  /** How many fewer than asked for there were room for. */
  readonly shortfall: number;
  /** Placements dropped because they changed what the rules do, with the key. */
  readonly rejected: readonly string[];
  /** How many handled exceptions had a ledger or bank record that could take a payload. */
  readonly slotCount: number;
  cleanup(): void;
}

export async function prepareOverlay(options: {
  readonly sourceDir: string;
  readonly preset: PresetName;
  readonly seed: number;
  readonly count: number;
}): Promise<OverlayPlan> {
  const { sourceDir, preset, seed, count } = options;
  const config = matcherConfigFor(seed, preset);
  const base = await loadDomainDataset(sourceDir);
  const keyOf = (id: string): string => base.truthKey.get(id) ?? id;
  const baseOut = runMatcher(base.input, config);
  const baseline = signature(baseOut, keyOf);

  // Every ledger entry and bank line that is the subject of, or a candidate in, an exception an agent
  // will look at. A subject's text is in its brief; a candidate's appears when the agent follows it up.
  const slots: OverlaySlot[] = [];
  for (const e of baseOut.exceptions) {
    if (
      skipReason({ id: '', cause: e.cause, subject: e.subject, candidates: e.candidates }) !== null
    )
      continue;
    for (const [ref, subject] of [
      [e.subject, true],
      ...e.candidates.map((c) => [c, false] as const),
    ] as const) {
      if (ref.recordType !== 'ledger_entry' && ref.recordType !== 'bank_line') continue;
      slots.push({ key: keyOf(ref.recordId), type: ref.recordType, subject });
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'ziro-eval-overlay-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const rejected = new Set<string>();
  const changesRules = async (items: readonly OverlayItem[]): Promise<boolean> => {
    rmSync(dir, { recursive: true, force: true });
    writeOverlayCopy(sourceDir, dir, items);
    const edited = await loadDomainDataset(dir);
    return (
      signature(runMatcher(edited.input, config), (id) => edited.truthKey.get(id) ?? id) !==
      baseline
    );
  };

  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const items = planOverlay(
        slots.filter((s) => !rejected.has(s.key)),
        count,
        seed,
      );
      if (!(await changesRules(items))) {
        return {
          dir,
          items,
          shortfall: Math.max(0, count - items.length),
          rejected: [...rejected].sort(),
          slotCount: new Set(slots.map((s) => s.key)).size,
          cleanup,
        };
      }
      // Find the placements that disturb the rules, one at a time, and plan again without them.
      const before = rejected.size;
      for (const item of items) if (await changesRules([item])) rejected.add(item.key);
      if (rejected.size === before)
        throw new Error(
          'the overlay changes what the rules do, but no single placement is to blame',
        );
    }
    throw new Error('could not find an overlay that leaves the rules unchanged');
  } catch (error) {
    cleanup();
    throw error;
  }
}
