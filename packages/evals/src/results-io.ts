// Reading and writing the result files. The only place the eval touches the disk besides the report.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ConfigName,
  CONFIGS,
  type LegName,
  LEGS,
  type ResultFile,
  resultFileSchema,
  type StressFile,
  stressFileSchema,
} from './results.js';

export const datasetFolder = (preset: string, seed: number): string => `${preset}-${seed}`;

export const resultPath = (
  dir: string,
  preset: string,
  seed: number,
  config: ConfigName,
  leg: LegName,
  cluster = false,
): string =>
  join(dir, datasetFolder(preset, seed), `${config}${cluster ? '+cluster' : ''}-${leg}.json`);

export const stressPath = (dir: string, seed: number): string =>
  join(dir, datasetFolder('stress', seed), 'rules-throughput.json');

export function writeResult(dir: string, file: ResultFile): string {
  const path = resultPath(
    dir,
    file.preset,
    file.seed,
    file.config,
    file.leg,
    file.clusterExceptions,
  );
  mkdirSync(join(dir, datasetFolder(file.preset, file.seed)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(resultFileSchema.parse(file), null, 2)}\n`);
  return path;
}

export function writeStress(dir: string, file: StressFile): string {
  const path = stressPath(dir, file.seed);
  mkdirSync(join(dir, datasetFolder('stress', file.seed)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stressFileSchema.parse(file), null, 2)}\n`);
  return path;
}

export interface ResultSet {
  readonly preset: string;
  readonly seed: number;
  readonly files: ReadonlyMap<string, ResultFile>;
  readonly stress: StressFile | null;
}

export const setKey = (config: ConfigName, leg: LegName, cluster = false): string =>
  `${config}${cluster ? '+cluster' : ''}/${leg}`;

/** Every result file for one dataset, plus the stress throughput if it has been measured. */
export function readResultSet(
  dir: string,
  preset: string,
  seed: number,
  stressSeed: number = seed,
): ResultSet {
  const files = new Map<string, ResultFile>();
  for (const config of CONFIGS) {
    for (const leg of LEGS) {
      for (const cluster of [false, true]) {
        const path = resultPath(dir, preset, seed, config, leg, cluster);
        if (!existsSync(path)) continue;
        files.set(
          setKey(config, leg, cluster),
          resultFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))),
        );
      }
    }
  }
  const stress = stressPath(dir, stressSeed);
  return {
    preset,
    seed,
    files,
    stress: existsSync(stress)
      ? stressFileSchema.parse(JSON.parse(readFileSync(stress, 'utf8')))
      : null,
  };
}

/** The datasets that have results, as `preset-seed` folder names. */
export function listDatasets(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
}
