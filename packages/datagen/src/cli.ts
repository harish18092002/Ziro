import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PRESET_NAMES, type PresetName, resolveConfig } from './config.js';
import { writeDataset } from './write.js';
import { generate } from './world/generate.js';

const USAGE = `Usage: npm run datagen -- --out <dir> [--seed 42] [--preset demo|eval|stress] [--force]

  --out     directory to write the dataset to (relative paths resolve from where you ran npm)
  --seed    unsigned 32-bit integer; the same seed always gives byte-identical files (default 42)
  --preset  demo (50 orders) | eval (500) | stress (~100k ledger rows, ~100k bank lines)  (default demo)
  --force   overwrite a non-empty output directory
`;

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

/** Runs the CLI. Returns the process exit code instead of exiting, so tests can call it. */
export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Output = console,
): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        seed: { type: 'string', default: '42' },
        preset: { type: 'string', default: 'demo' },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    out.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    out.log(USAGE);
    return 0;
  }
  if (!values.out) {
    out.error(`--out is required\n\n${USAGE}`);
    return 2;
  }
  const seed = /^\d+$/.test(values.seed) ? Number(values.seed) : Number.NaN;
  if (!Number.isSafeInteger(seed) || seed > 0xffff_ffff) {
    out.error(`--seed must be an integer from 0 to 4294967295, got "${values.seed}"`);
    return 2;
  }
  if (!(PRESET_NAMES as readonly string[]).includes(values.preset)) {
    out.error(`--preset must be one of ${PRESET_NAMES.join(', ')}, got "${values.preset}"`);
    return 2;
  }

  try {
    const config = resolveConfig(seed, values.preset as PresetName);
    // npm runs workspace scripts from the package directory; INIT_CWD is where the user typed it.
    const dir = resolve(env['INIT_CWD'] ?? process.cwd(), values.out);
    const data = generate(config);
    const files = writeDataset(dir, data, { force: values.force });

    out.log(`datagen: preset=${config.preset} seed=${config.seed} -> ${dir}`);
    out.log(
      `  ${data.ledger.length} ledger rows, ${data.payments.length} payments, ${data.refunds.length} refunds, ` +
        `${data.settlements.length} settlements, ${data.items.length} recon lines, ${data.bank.length} bank lines`,
    );
    out.log(
      `  ${data.anomalies.length} anomalies in ${data.groups.length} groups; wrote ${files.join(', ')}`,
    );
    return 0;
  } catch (err) {
    out.error(`datagen failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
