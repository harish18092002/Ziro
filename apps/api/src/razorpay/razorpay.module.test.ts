import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import { type Env, loadEnv } from '../config/env.js';
import { resolveDataDir } from './data-dir.js';
import { RazorpayConfigError } from './errors.js';
import { RazorpayModule, RazorpaySourceFactory } from './razorpay.module.js';
import {
  makeSyntheticDataset,
  RUN_ID,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
  type TempDataset,
} from './razorpay.fixtures.js';
import { SyntheticSource } from './synthetic.source.js';
import { TestModeSource } from './testmode.source.js';

let data: TempDataset;
beforeAll(() => {
  data = makeSyntheticDataset('demo', 42);
});
afterAll(() => data.cleanup());

const baseEnv = (): Record<string, string> => ({
  DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5433/ziro',
  REDIS_URL: 'redis://localhost:6379',
  RAZORPAY_SOURCE: 'synthetic',
  SYNTHETIC_DATA_DIR: data.dir,
  AGENT_HARNESS: 'loop',
  AUTO_ACCEPT_ENABLED: 'false',
  AUTO_ACCEPT_MAX_PAISE: '0',
  DEMO_MODE: 'true',
  DAILY_LLM_BUDGET_USD: '5',
  AGENT_KILL_SWITCH: 'false',
});

async function factoryFor(env: Env): Promise<RazorpaySourceFactory> {
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env), RazorpayModule],
  }).compile();
  return module.get(RazorpaySourceFactory);
}

describe('RazorpaySourceFactory (through Nest DI)', () => {
  it('builds a SyntheticSource that reads the configured dataset when RAZORPAY_SOURCE=synthetic', async () => {
    const factory = await factoryFor(loadEnv(baseEnv()));
    const source = factory.forRun(RUN_ID);
    expect(source).toBeInstanceOf(SyntheticSource);
    const { items } = await source.fetchPayments({ from: '2026-09-01', to: '2026-10-15' });
    expect(items).toHaveLength(data.collections.payments.length);
  });

  it('builds a TestModeSource with the synthetic dataset as its fallback when RAZORPAY_SOURCE=testmode', async () => {
    const env = loadEnv({
      ...baseEnv(),
      RAZORPAY_SOURCE: 'testmode',
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
    });
    const source = (await factoryFor(env)).forRun(RUN_ID);
    expect(source).toBeInstanceOf(TestModeSource);
  });

  it('refuses testmode without keys even if the env check were bypassed', () => {
    const env = { ...loadEnv(baseEnv()), RAZORPAY_SOURCE: 'testmode' as const };
    expect(() => new RazorpaySourceFactory(env).forRun(RUN_ID)).toThrow(RazorpayConfigError);
  });

  it('refuses a live key at the very last line of defence, after the boot guard', () => {
    const env = {
      ...loadEnv(baseEnv()),
      RAZORPAY_SOURCE: 'testmode' as const,
      RAZORPAY_KEY_ID: 'rzp_live_abc123',
      RAZORPAY_KEY_SECRET: 's',
    };
    expect(() => new RazorpaySourceFactory(env).forRun(RUN_ID)).toThrow(/forbidden/);
  });
});

describe('SYNTHETIC_DATA_DIR is a required setting', () => {
  it('fails fast at boot when it is missing', () => {
    const { SYNTHETIC_DATA_DIR: _omitted, ...without } = baseEnv();
    expect(() => loadEnv(without)).toThrow(/SYNTHETIC_DATA_DIR: is required/);
  });
});

describe('resolveDataDir', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ziro-datadir-'));
    mkdirSync(join(root, 'data', 'demo'), { recursive: true });
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('keeps an absolute path as it is', () => {
    expect(resolveDataDir(data.dir, '/anywhere')).toBe(data.dir);
  });

  it('finds a relative path from the working directory', () => {
    expect(resolveDataDir('data/demo', root)).toBe(join(root, 'data', 'demo'));
  });

  it('finds the repo-root data directory when started from apps/api, as npm does', () => {
    expect(resolveDataDir('data/demo', join(root, 'apps', 'api'))).toBe(join(root, 'data', 'demo'));
  });

  it('returns the first candidate for a path that exists nowhere, so the read error can explain', () => {
    expect(resolveDataDir('data/missing', root)).toBe(join(root, 'data', 'missing'));
  });
});
