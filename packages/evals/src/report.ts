// EVALS.md, written from the stored result files and nothing else. Every number in it traces to a JSON
// file, so it can be rebuilt for free at any time and a reader can check any figure. The prose under
// "What the numbers show" is generated from the same numbers and states only what they say, with an
// explicit note when two ranges overlap. The Opinion block is the author's: regeneration keeps it.
import { formatRupees, paise } from '@ziro/core/money';
import { type ConfigName, CONFIGS, type RunRecord } from './results.js';
import { type ResultSet, setKey } from './results-io.js';
import { summarize } from './stats.js';

export const OPINION_START = '<!-- OPINION:START -->';
export const OPINION_END = '<!-- OPINION:END -->';
const OPINION_PLACEHOLDER =
  '_Not written yet. This block is yours: the report keeps whatever is between the markers._';

// --- formatting ------------------------------------------------------------------------------------------

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const usd = (micro: number): string => {
  const dollars = micro / 1_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
};
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const rupees = (paiseText: number): string =>
  formatRupees(paise(BigInt(Math.round(paiseText))), { symbol: true });
const tokens = (x: number): string =>
  x >= 10_000 ? `${(x / 1000).toFixed(0)}k` : String(Math.round(x));

/** `mean (min–max)` over the repeats; a single run is shown as itself; nothing is shown as a dash. */
function spread(
  values: readonly (number | null | undefined)[],
  fmt: (x: number) => string,
): string {
  const s = summarize(
    values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
  );
  if (s === null) return '–';
  return s.n === 1 || s.min === s.max
    ? fmt(s.mean)
    : `${fmt(s.mean)} (${fmt(s.min)}–${fmt(s.max)})`;
}

const runsOf = (
  set: ResultSet,
  config: ConfigName,
  leg: 'plain' | 'attacked',
  cluster = false,
): RunRecord[] => set.files.get(setKey(config, leg, cluster))?.runs ?? [];

const col = <T>(runs: readonly RunRecord[], pick: (r: RunRecord) => T): T[] => runs.map(pick);

/** Do the repeat-to-repeat ranges of two series fail to overlap? Only then do they separate. */
function separated(a: readonly number[], b: readonly number[]): boolean {
  const [sa, sb] = [summarize(a), summarize(b)];
  return sa !== null && sb !== null && (sa.max < sb.min || sb.max < sa.min);
}

// --- tables ------------------------------------------------------------------------------------------------

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

const label = (config: ConfigName, cluster = false): string =>
  `**${config}**${cluster ? ' + clustering' : ''}`;

function headline(set: ResultSet): string {
  const rows: string[][] = [];
  for (const config of CONFIGS) {
    const runs = runsOf(set, config, 'plain');
    if (runs.length === 0) {
      rows.push([label(config), 'not run', '', '', '', '', '', '', '', '']);
      continue;
    }
    const llm = config !== 'rules';
    rows.push([
      label(config),
      String(runs.length),
      spread(
        col(runs, (r) => r.groups.matchRate),
        pct,
      ),
      spread(
        col(runs, (r) => r.groups.precision),
        pct,
      ),
      spread(
        col(runs, (r) => r.groups.falseMatches),
        num,
      ),
      llm
        ? spread(
            col(runs, (r) => r.reasonCodes?.accuracy),
            pct,
          )
        : '–',
      llm
        ? spread(
            col(runs, (r) => r.verifier.rejected),
            num,
          )
        : '–',
      spread(
        col(runs, (r) => Number(r.gap.strictPaise)),
        rupees,
      ),
      llm
        ? spread(
            col(runs, (r) => r.cost.per1kOrdersMicroUsd),
            usd,
          )
        : '–',
      llm
        ? `${spread(
            col(runs, (r) => r.latency.p50Ms),
            secs,
          )} / ${spread(
            col(runs, (r) => r.latency.p95Ms),
            secs,
          )}`
        : '–',
    ]);
  }
  return table(
    [
      'config',
      'runs',
      'match rate',
      'precision',
      '**false matches**',
      'reason-code accuracy',
      'rejected by verifier',
      'Ziro gap (strict)',
      'cost / 1k orders',
      'latency p50 / p95',
    ],
    rows,
  );
}

function tokensTable(set: ResultSet): string {
  const rows: string[][] = [];
  for (const config of CONFIGS.filter((c) => c !== 'rules')) {
    const runs = runsOf(set, config, 'plain');
    if (runs.length === 0) continue;
    rows.push([
      label(config),
      spread(
        col(runs, (r) => r.cost.tokens.input),
        tokens,
      ),
      spread(
        col(runs, (r) => r.cost.tokens.output),
        tokens,
      ),
      spread(
        col(runs, (r) => r.cost.tokens.cacheRead),
        tokens,
      ),
      spread(
        col(runs, (r) => r.cost.llmCalls),
        num,
      ),
      spread(
        col(runs, (r) => r.latency.investigations),
        num,
      ),
      spread(
        col(runs, (r) => r.cost.totalMicroUsd),
        usd,
      ),
      config === 'harnessB'
        ? spread(
            col(runs, (r) => r.cost.sdkReportedMicroUsd),
            usd,
          )
        : '–',
    ]);
  }
  return rows.length === 0
    ? '_No agent runs yet._'
    : table(
        [
          'config',
          'tokens in',
          'tokens out',
          'cache reads',
          'model calls',
          'investigations',
          'run cost',
          'cost the SDK reported',
        ],
        rows,
      );
}

function falseMatches(set: ResultSet): string {
  const out: string[] = [];
  for (const config of CONFIGS) {
    const runs = runsOf(set, config, 'plain');
    if (runs.length === 0) continue;
    const total = runs.reduce((n, r) => n + r.groups.falseMatches, 0);
    const accepted = runs.map((r) => r.groups.accepted.total);
    out.push(
      `- ${label(config)}: **${total}** false matches in ${runs.length} run(s), over ${spread(accepted, num)} accepted groups each. ` +
        `Agent-made: ${runs.reduce((n, r) => n + r.groups.agentAdded.falseMatches, 0)}.`,
    );
    const example = runs.flatMap((r) => r.groups.falseMatchExamples)[0];
    if (example !== undefined) {
      out.push(
        `  - first: group ${example.groupId} (${example.origin}) linked ${example.keys.join(', ')}; these belong to ${example.homes.join(' and ')}.`,
      );
    }
  }
  return out.length === 0 ? '_No runs yet._' : out.join('\n');
}

function reasonCodes(set: ResultSet): string {
  const blocks: string[] = [];
  for (const config of CONFIGS.filter((c) => c !== 'rules')) {
    const runs = runsOf(set, config, 'plain');
    const scored = runs.flatMap((r) => (r.reasonCodes === null ? [] : [r.reasonCodes]));
    if (scored.length === 0) continue;
    const merged = new Map<string, { n: number; correct: number }>();
    for (const s of scored) {
      for (const [expected, v] of Object.entries(s.byExpected)) {
        const m = merged.get(expected) ?? { n: 0, correct: 0 };
        merged.set(expected, { n: m.n + v.n, correct: m.correct + v.correct });
      }
    }
    const rows = [...merged.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([expected, v]) => [expected, String(v.n), `${v.correct} (${pct(v.correct / v.n)})`]);
    blocks.push(
      `**${config}**: handled ${spread(
        scored.map((s) => s.handled),
        num,
      )}, concluded ${spread(
        scored.map((s) => s.concluded),
        num,
      )}, ` +
        `accuracy on those that concluded ${spread(
          scored.map((s) => s.accuracyConcluded),
          pct,
        )}. Counts below are summed over ${scored.length} run(s).\n\n` +
        table(['truth expects', 'cases', 'agent code right'], rows),
    );
  }
  return blocks.length === 0 ? '_No agent runs yet._' : blocks.join('\n\n');
}

function verifierSection(set: ResultSet): string {
  const out: string[] = [];
  for (const config of CONFIGS.filter((c) => c !== 'rules')) {
    const runs = runsOf(set, config, 'plain');
    if (runs.length === 0) continue;
    const proposals = runs.reduce((n, r) => n + r.verifier.proposals, 0);
    const rejected = runs.reduce((n, r) => n + r.verifier.rejected, 0);
    out.push(
      `- ${label(config)}: ${rejected} of ${proposals} proposals rejected across ${runs.length} run(s) ` +
        `(${spread(
          col(runs, (r) => r.verifier.rejected),
          num,
        )} per run).`,
    );
    for (const ex of runs.flatMap((r) => r.verifier.rejectedExamples).slice(0, 3)) {
      out.push(
        `  - ${ex.subjectKey} (${ex.reasonCode}): ${ex.findings.join(' | ') || 'no finding recorded'}`,
      );
    }
  }
  return out.length === 0 ? '_No agent runs yet._' : out.join('\n');
}

function injectionSection(set: ResultSet): string {
  const rows: string[][] = [];
  const cases: string[] = [];
  for (const config of CONFIGS.filter((c) => c !== 'rules')) {
    const runs = runsOf(set, config, 'attacked').filter((r) => r.injection !== null);
    if (runs.length === 0) continue;
    const exposed = runs.reduce((n, r) => n + (r.injection?.exposed ?? 0), 0);
    const followed = runs.reduce((n, r) => n + (r.injection?.followed ?? 0), 0);
    const flagged = runs.reduce((n, r) => n + (r.injection?.flaggedByAgent ?? 0), 0);
    const plain = runsOf(set, config, 'plain');
    rows.push([
      label(config),
      String(runs.length),
      spread(
        col(runs, (r) => r.injection?.planted),
        num,
      ),
      String(exposed),
      String(followed),
      exposed === 0 ? '–' : pct(1 - followed / exposed),
      String(flagged),
      plain.length === 0
        ? '–'
        : `${spread(
            col(plain, (r) => r.reasonCodes?.accuracy),
            pct,
          )} → ${spread(
            col(runs, (r) => r.reasonCodes?.accuracy),
            pct,
          )}`,
    ]);
    for (const r of runs) {
      for (const c of r.injection?.cases ?? []) {
        if (c.followed)
          cases.push(
            `- ${config} run ${r.repeat}: **${c.style}** on ${c.key}: ${c.reasons.join('; ')}`,
          );
      }
    }
  }
  if (rows.length === 0) return '_No attacked-leg runs yet._';
  return [
    table(
      [
        'config',
        'runs',
        'payloads planted',
        'exposed (seen in a tool result)',
        'followed',
        'ignored',
        'agent called it out',
        'reason-code accuracy plain → attacked',
      ],
      rows,
    ),
    '',
    cases.length === 0
      ? 'No case was flagged as followed.'
      : `Cases flagged as followed (judge these yourself; the detector is a heuristic):\n${cases.slice(0, 20).join('\n')}`,
  ].join('\n');
}

function clusteringSection(set: ResultSet): string {
  const rows: string[][] = [];
  for (const config of CONFIGS.filter((c) => c !== 'rules')) {
    const off = runsOf(set, config, 'plain', false);
    const on = runsOf(set, config, 'plain', true);
    if (off.length === 0 || on.length === 0) continue;
    for (const [name, runs] of [
      ['off', off],
      ['on', on],
    ] as const) {
      rows.push([
        label(config),
        name,
        String(runs.length),
        spread(
          col(runs, (r) => r.reasonCodes?.accuracy),
          pct,
        ),
        spread(
          col(runs, (r) => r.groups.matchRate),
          pct,
        ),
        spread(
          col(runs, (r) => r.cost.per1kOrdersMicroUsd),
          usd,
        ),
        spread(
          col(runs, (r) => r.latency.investigations),
          num,
        ),
      ]);
    }
  }
  return rows.length === 0
    ? '_Not run yet._'
    : table(
        [
          'config',
          'clustering',
          'runs',
          'reason-code accuracy',
          'match rate',
          'cost / 1k orders',
          'conversations',
        ],
        rows,
      );
}

function throughputSection(set: ResultSet): string {
  const s = set.stress;
  if (s === null) return '_Not measured yet._';
  return (
    `${s.inputRows.toLocaleString('en-IN')} input rows, ${s.milliseconds.length} timed run(s): ` +
    `**${spread(s.rowsPerSecond, (x) => `${Math.round(x).toLocaleString('en-IN')} rows/s`)}**, ` +
    `${spread(s.milliseconds, (x) => `${Math.round(x)} ms`)} per pass. ` +
    `The rules produced ${s.groups.toLocaleString('en-IN')} groups and ${s.exceptions.toLocaleString('en-IN')} exceptions. ` +
    'Pure CPU, no database and no model; the time excludes loading the files.'
  );
}

// --- the neutral reading -------------------------------------------------------------------------------------

function whatTheNumbersShow(set: ResultSet): string {
  const lines: string[] = [];
  const present = CONFIGS.filter((c) => runsOf(set, c, 'plain').length > 0);

  const fm = present.map(
    (c) => `${c} ${runsOf(set, c, 'plain').reduce((n, r) => n + r.groups.falseMatches, 0)}`,
  );
  if (fm.length > 0) lines.push(`False matches (all runs summed): ${fm.join(', ')}.`);

  const rates = present.map(
    (c) =>
      `${c} ${spread(
        col(runsOf(set, c, 'plain'), (r) => r.groups.matchRate),
        pct,
      )}`,
  );
  if (rates.length > 0) lines.push(`Match rate: ${rates.join('; ')}.`);

  const rules = runsOf(set, 'rules', 'plain');
  for (const c of present.filter((x) => x !== 'rules')) {
    const runs = runsOf(set, c, 'plain');
    const added = runs.map((r) => r.groups.agentAdded.exact);
    lines.push(
      `${c} added ${spread(added, num)} exactly-right group(s) beyond the rules` +
        (rules.length > 0
          ? `, and left the Ziro gap at ${spread(
              col(runs, (r) => Number(r.gap.strictPaise)),
              rupees,
            )} against ${spread(
              col(rules, (r) => Number(r.gap.strictPaise)),
              rupees,
            )} for the rules alone (strict: only verified, approved matches settle).`
          : '.'),
    );
  }

  const llm = present.filter((c) => c !== 'rules');
  for (let i = 0; i < llm.length; i += 1) {
    for (let j = i + 1; j < llm.length; j += 1) {
      const [a, b] = [llm[i], llm[j]] as [ConfigName, ConfigName];
      const [ra, rb] = [runsOf(set, a, 'plain'), runsOf(set, b, 'plain')];
      const acc = (rs: RunRecord[]) =>
        rs.map((r) => r.reasonCodes?.accuracy).filter((x): x is number => typeof x === 'number');
      const [aa, ab] = [acc(ra), acc(rb)];
      if (aa.length > 0 && ab.length > 0) {
        lines.push(
          `Reason-code accuracy, ${a} vs ${b}: ${spread(aa, pct)} vs ${spread(ab, pct)}; ` +
            (separated(aa, ab)
              ? 'the repeat ranges do not overlap.'
              : 'the repeat ranges overlap, so these runs do not separate them.'),
        );
      }
      const [ca, cb] = [
        ra.map((r) => r.cost.per1kOrdersMicroUsd),
        rb.map((r) => r.cost.per1kOrdersMicroUsd),
      ];
      const [ma, mb] = [summarize(ca), summarize(cb)];
      if (ma !== null && mb !== null && ma.mean > 0 && mb.mean > 0) {
        lines.push(
          `Cost per 1k orders, ${a} vs ${b}: ${usd(ma.mean)} vs ${usd(mb.mean)} (${(mb.mean / ma.mean).toFixed(1)}× ${b} to ${a}).`,
        );
      }
    }
  }

  const v = llm.map((c) => {
    const rs = runsOf(set, c, 'plain');
    return `${c} ${rs.reduce((n, r) => n + r.verifier.rejected, 0)} of ${rs.reduce((n, r) => n + r.verifier.proposals, 0)}`;
  });
  if (v.length > 0)
    lines.push(`Proposals the verifier rejected (all runs summed): ${v.join('; ')}.`);

  for (const c of llm) {
    const att = runsOf(set, c, 'attacked');
    const exposed = att.reduce((n, r) => n + (r.injection?.exposed ?? 0), 0);
    const followed = att.reduce((n, r) => n + (r.injection?.followed ?? 0), 0);
    if (exposed > 0)
      lines.push(
        `Injection, ${c}: ${followed} of ${exposed} exposures were followed (heuristic detector).`,
      );
  }
  return lines.length === 0 ? '_No results yet._' : lines.map((l) => `- ${l}`).join('\n');
}

const LIMITS = [
  'One dataset (one seed) and, for the model configs, three repeats: ranges are shown, not confidence intervals, and no difference is claimed unless the ranges do not overlap.',
  'The data is synthetic. A model that does well here has not been shown to do well on a real merchant’s records.',
  'Accepted groups include every verified agent match, as if a reviewer approved all of them. A careful human would reject some, so false matches here are an upper bound on what a person would let through.',
  'Reason-code accuracy is scored against the codes datagen planted; several reasons have only a handful of records, so read the per-code counts, not just the percentage.',
  'Injection “followed” is decided by heuristics on what the agent did; every flagged case is listed so it can be overruled. “Exposed” means the payload appeared in a tool result during the investigation.',
  'Costs are computed from token counts with the rates in `agent/pricing.ts` for every config, so they compare like for like; the Agent SDK’s own estimate is shown beside it.',
  'Latency is wall time per investigation with four investigations running at once, and includes the Agent SDK’s process start for harness B.',
];

// --- the document --------------------------------------------------------------------------------------------

export interface RenderInput {
  readonly set: ResultSet;
  /** The previous EVALS.md, if any, so the Opinion block survives. */
  readonly previous: string | null;
}

export function extractOpinion(previous: string | null): string {
  if (previous === null) return OPINION_PLACEHOLDER;
  const start = previous.indexOf(OPINION_START);
  const end = previous.indexOf(OPINION_END);
  if (start < 0 || end < start) return OPINION_PLACEHOLDER;
  return previous.slice(start + OPINION_START.length, end).trim() || OPINION_PLACEHOLDER;
}

export function renderEvals({ set, previous }: RenderInput): string {
  const first = [...set.files.values()][0]?.runs[0];
  const any = first ?? null;
  const dataset =
    any === null
      ? `${set.preset}, seed ${set.seed}`
      : `${set.preset}, seed ${set.seed}: ${any.orders} orders, ${any.groups.truthGroups} truth groups, ${any.exceptions.total} exceptions of which ${any.exceptions.handled} go to an agent and ${any.exceptions.skipped} are unexplained bank credits listed for a person`;
  const versions = [...set.files.values()][0]?.versions;

  return [
    '# EVALS',
    '',
    '> Written by `npm run eval:report` from the JSON in `packages/evals/results/`. Do not edit by hand, except inside the Opinion block at the end. Re-running the model configs costs money (`npm run eval`); rebuilding this file does not.',
    '',
    `**Dataset:** ${dataset}.`,
    versions === undefined
      ? ''
      : `**Models:** small \`${versions.models.small}\`, large \`${versions.models.large}\`. **Agent SDK:** ${versions.agentSdk ?? 'not used'}. **Node:** ${versions.node}.`,
    '',
    '## Results',
    '',
    headline(set),
    '',
    'Match rate: truth groups reproduced exactly by an accepted group. Precision: accepted groups with no wrong link. **False matches**: accepted groups that link records truth says do not belong together; the worst error, because it books money against the wrong thing. The Ziro gap is what is left unexplained when only the rules and verified, approved agent matches settle anything. Model rows show mean (min–max) over the repeats.',
    '',
    '### False matches',
    '',
    falseMatches(set),
    '',
    '### Tokens, calls and cost',
    '',
    tokensTable(set),
    '',
    '### Reason-code accuracy',
    '',
    reasonCodes(set),
    '',
    '### Proposals rejected by the verifier',
    '',
    verifierSection(set),
    '',
    '### Prompt injection',
    '',
    injectionSection(set),
    '',
    '### Clustering related exceptions: off vs on',
    '',
    clusteringSection(set),
    '',
    '### Rules throughput (stress preset)',
    '',
    throughputSection(set),
    '',
    '## What the numbers show',
    '',
    whatTheNumbersShow(set),
    '',
    '### Limits of this evidence',
    '',
    LIMITS.map((l) => `- ${l}`).join('\n'),
    '',
    '## Opinion',
    '',
    OPINION_START,
    extractOpinion(previous),
    OPINION_END,
    '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
}
