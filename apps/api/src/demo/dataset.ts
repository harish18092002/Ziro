// The demo's data, generated in-process from a seed the first time it is asked for and kept in the
// temp directory afterwards. The generator is deterministic, so every server produces the same files.
// Nothing needs to be prepared on disk or shipped in the image.
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, resolveConfig, writeDataset } from '@ziro/datagen';

export type DemoPreset = 'demo' | 'eval';
export const DEMO_SEED = 42;

const inFlight = new Map<string, Promise<string>>();

/** The directory holding the generated files for a preset, creating them on first use. */
export function datasetDir(preset: DemoPreset, seed: number = DEMO_SEED): Promise<string> {
  const key = `${preset}-${seed}`;
  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = build(preset, seed, key).catch((error: unknown) => {
      inFlight.delete(key); // do not cache a failure
      throw error;
    });
    inFlight.set(key, pending);
  }
  return pending;
}

async function build(preset: DemoPreset, seed: number, key: string): Promise<string> {
  const base = join(tmpdir(), 'ziro-demo-data');
  const dir = join(base, key);
  if (await exists(join(dir, 'truth.json'))) return dir;

  // Written beside the final place and renamed into it, so a half-written directory is never read.
  await mkdir(base, { recursive: true });
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  await mkdir(staging, { recursive: true });
  try {
    writeDataset(staging, generate(resolveConfig(seed, preset)));
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another process may have finished first; if so its directory is just as good.
    if (await exists(join(dir, 'truth.json'))) return dir;
    throw error;
  }
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
