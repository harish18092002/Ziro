import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_FLAG, isConfirmed, NOT_CONFIRMED_MESSAGE } from './probe-guard.js';

describe('the Razorpay probe confirmation guard', () => {
  it('is not confirmed by default, or by anything but the exact flag', () => {
    for (const argv of [
      [],
      ['node', 'probe.ts'],
      ['--yes'],
      ['--confirmed'],
      ['-confirm'],
      ['confirm'],
    ]) {
      expect(isConfirmed(argv), argv.join(' ')).toBe(false);
    }
  });

  it('is confirmed only by --confirm', () => {
    expect(isConfirmed(['node', 'probe.ts', CONFIRM_FLAG])).toBe(true);
  });

  it('tells the user exactly how to run it', () => {
    expect(NOT_CONFIRMED_MESSAGE).toContain('npm run razorpay:probe -w @ziro/api -- --confirm');
    expect(NOT_CONFIRMED_MESSAGE).toContain('has NOT run');
  });

  it('is the first thing the script checks, before it reads .env or builds a client', () => {
    const script = readFileSync(new URL('./razorpay-probe.ts', import.meta.url), 'utf8');
    const mainBody = script.slice(script.indexOf('async function main()'));
    const guard = mainBody.indexOf('isConfirmed(process.argv)');
    expect(guard).toBeGreaterThan(-1);
    for (const later of ['loadDotEnv()', 'createSdkClient(', 'process.env']) {
      expect(mainBody.indexOf(later), later).toBeGreaterThan(guard);
    }
  });
});
