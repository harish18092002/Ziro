// Runs the UTR extractor over every settlement credit datagen produced and compares it with what
// the generator KNOWS it did to that line: the true UTR and the damage (clean, truncated, split,
// garbled, missing). This is the measured, reproducible version of the extractor's claims.
import { extractUtr } from '@ziro/core/normalize';
import { type Dataset, generate, resolveConfig } from '@ziro/datagen';
import { describe, expect, it } from 'vitest';

interface Tally {
  lines: number;
  byVariant: Record<string, Record<string, number>>;
  /** A `repaired` UTR that is not the true one: the failure that would cause a wrong match. */
  falseRepairs: number;
  /** An `exact` UTR that is not the true one on a line the generator did NOT garble. */
  falseExact: number;
  /** A fragment that is not a prefix of the true UTR. */
  falseFragments: number;
}

function measure(data: Dataset): Tally {
  const trueUtr = new Map(data.settlements.map((s) => [s.id, s.utr]));
  const tally: Tally = {
    lines: 0,
    byVariant: {},
    falseRepairs: 0,
    falseExact: 0,
    falseFragments: 0,
  };

  for (const line of data.bank) {
    if (line.settlementId === null) continue;
    const truth = trueUtr.get(line.settlementId);
    if (truth === undefined) throw new Error(`no settlement ${line.settlementId}`);
    const variant = line.utrVariant ?? 'clean';
    const found = extractUtr(line.narration);

    const outcome = found.utr === null ? 'none' : found.quality;
    const row = (tally.byVariant[variant] ??= {});
    row[outcome] = (row[outcome] ?? 0) + 1;
    tally.lines += 1;

    if (found.quality === 'repaired' && found.utr !== truth) tally.falseRepairs += 1;
    if (
      found.quality === 'exact' &&
      found.utr !== truth &&
      variant !== 'garbled' &&
      variant !== 'missing'
    ) {
      tally.falseExact += 1;
    }
    if (found.quality === 'truncated' && !truth.startsWith(found.utr)) tally.falseFragments += 1;
  }
  return tally;
}

describe.each([
  ['demo', 42],
  ['eval', 42],
  ['eval', 7],
  ['eval', 2026],
] as const)('extractUtr against datagen truth: %s preset, seed %i', (preset, seed) => {
  const data = generate(resolveConfig(seed, preset));
  const tally = measure(data);

  it('covers every settlement credit', () => {
    expect(tally.lines).toBe(data.settlements.length);
  });

  it('reads every undamaged UTR exactly, and never reads a wrong one as right', () => {
    const clean = tally.byVariant['clean'] ?? {};
    expect(Object.keys(clean)).toEqual(['exact']);
    expect(tally.falseExact).toBe(0);
  });

  it('never "repairs" a UTR into a wrong one', () => {
    expect(tally.falseRepairs).toBe(0);
  });

  it('only ever reports a fragment that really starts the true UTR', () => {
    expect(tally.falseFragments).toBe(0);
  });

  it('rejoins every split UTR and recognises every truncated one', () => {
    expect(Object.keys(tally.byVariant['split'] ?? {}).filter((k) => k !== 'rejoined')).toEqual([]);
    expect(
      Object.keys(tally.byVariant['truncated'] ?? {}).filter((k) => k !== 'truncated'),
    ).toEqual([]);
  });

  it('finds nothing for a missing UTR, except an IMPS reference that is not a settlement UTR', () => {
    const missing = data.bank.filter((l) => l.settlementId !== null && l.utrVariant === 'missing');
    for (const line of missing) {
      const found = extractUtr(line.narration);
      if (found.utr !== null) {
        expect(found.channel).toBe('imps');
        expect(found.utr).toMatch(/^\d{12}$/);
      }
    }
  });
});

describe('what the extractor can and cannot see (eval preset, seed 42)', () => {
  it('pins the measured outcome per damage type, so the README numbers are reproducible', () => {
    const tally = measure(generate(resolveConfig(42, 'eval')));
    expect(tally.byVariant).toMatchInlineSnapshot(`
      {
        "clean": {
          "exact": 39,
        },
        "garbled": {
          "repaired": 3,
        },
        "missing": {
          "none": 3,
        },
        "split": {
          "rejoined": 1,
        },
        "truncated": {
          "truncated": 3,
        },
      }
    `);
  });
});
