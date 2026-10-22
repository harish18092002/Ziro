import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Where the synthetic dataset lives. A relative path is tried from the working directory and from
 * the repo root two levels up (npm runs workspace scripts from apps/api), so `data/demo` works
 * however the API was started. A path that exists nowhere is returned as-is: reading it later fails
 * with a message that says how to generate it.
 */
export function resolveDataDir(configured: string, cwd: string = process.cwd()): string {
  if (isAbsolute(configured)) return configured;
  const candidates = [resolve(cwd, configured), resolve(cwd, '..', '..', configured)];
  return candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);
}
