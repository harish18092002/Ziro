import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the repo-root .env into process.env, if one exists. Already-set variables win, so real
 * environment variables (Cloud Run, CI) are never overridden. Only cwd and the repo root (two up
 * from apps/api) are checked: never a .env that happens to sit higher up the disk.
 */
export function loadDotEnv(cwd: string = process.cwd()): string | undefined {
  const file = [join(cwd, '.env'), join(cwd, '..', '..', '.env')].find((candidate) =>
    existsSync(candidate),
  );
  if (file) process.loadEnvFile(file);
  return file;
}
