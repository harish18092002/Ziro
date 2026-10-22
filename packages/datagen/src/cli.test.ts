import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { FILE_NAMES } from './render/files.js';

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ziro-datagen-'));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv = { INIT_CWD: base }) {
  const log: string[] = [];
  const error: string[] = [];
  const code = main(args, env, { log: (m) => log.push(m), error: (m) => error.push(m) });
  return { code, log: log.join('\n'), error: error.join('\n') };
}

const hashDir = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(dir, name)))
          .digest('hex'),
      ]),
  );

describe('datagen CLI', () => {
  it('writes all eight files, resolving a relative --out from INIT_CWD', () => {
    const { code, log } = run(['--seed', '42', '--preset', 'demo', '--out', 'data/demo']);
    expect(code).toBe(0);
    expect(readdirSync(join(base, 'data', 'demo')).sort()).toEqual([...FILE_NAMES].sort());
    expect(log).toContain('preset=demo seed=42');
  });

  it('produces byte-identical files for the same seed in a different directory', () => {
    expect(run(['--seed', '42', '--preset', 'demo', '--out', 'again']).code).toBe(0);
    expect(hashDir(join(base, 'again'))).toEqual(hashDir(join(base, 'data', 'demo')));
  });

  it('produces different files for a different seed', () => {
    expect(run(['--seed', '43', '--preset', 'demo', '--out', 'other']).code).toBe(0);
    expect(hashDir(join(base, 'other'))['ledger.csv']).not.toBe(
      hashDir(join(base, 'data', 'demo'))['ledger.csv'],
    );
  });

  it('refuses to write into a non-empty directory unless --force is given', () => {
    const refused = run(['--preset', 'demo', '--out', 'data/demo']);
    expect(refused.code).toBe(1);
    expect(refused.error).toMatch(/not empty/);
    writeFileSync(join(base, 'data', 'demo', 'ledger.csv'), 'tampered');
    expect(run(['--preset', 'demo', '--out', 'data/demo', '--force']).code).toBe(0);
    expect(readFileSync(join(base, 'data', 'demo', 'ledger.csv'), 'utf8')).toMatch(
      /^order_ref,order_date/,
    );
  });

  it('defaults to seed 42 and the demo preset', () => {
    expect(run(['--out', 'defaults']).code).toBe(0);
    expect(hashDir(join(base, 'defaults'))).toEqual(hashDir(join(base, 'data', 'demo')));
  });

  it.each([
    [[], /--out is required/],
    [['--out', 'x1', '--preset', 'huge'], /--preset must be one of/],
    [['--out', 'x2', '--seed', 'abc'], /--seed must be/],
    [['--out', 'x3', '--seed', '-5'], /--seed/],
    [['--out', 'x4', '--seed', '4294967296'], /--seed must be an integer from 0 to 4294967295/],
    [['--out', 'x5', '--seed', '1.5'], /--seed must be/],
    [['--out', 'x6', '--bogus'], /bogus/],
  ])('exits 2 with usage for bad arguments %j', (args, message) => {
    const { code, error } = run(args);
    expect(code).toBe(2);
    expect(error).toMatch(message);
    expect(existsSync(join(base, String(args[1])))).toBe(false);
  });

  it('accepts the largest 32-bit seed', () => {
    expect(run(['--out', 'maxseed', '--seed', '4294967295']).code).toBe(0);
  });

  it('exits 1 with a message, not a stack trace, when the output cannot be written', () => {
    writeFileSync(join(base, 'blocker'), 'a file, not a directory');
    const { code, error } = run(['--out', 'blocker/inside']);
    expect(code).toBe(1);
    expect(error).toMatch(/^datagen failed: /);
  });

  it('prints usage for --help and writes nothing', () => {
    const { code, log } = run(['--help']);
    expect(code).toBe(0);
    expect(log).toMatch(/Usage: npm run datagen/);
  });
});
