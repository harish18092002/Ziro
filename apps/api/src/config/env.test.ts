import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const validEnv = (): Record<string, string> => ({
  PORT: '3000',
  DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5432/ziro',
  REDIS_URL: 'redis://localhost:6379',
  RAZORPAY_SOURCE: 'synthetic',
  SYNTHETIC_DATA_DIR: 'data/demo',
  AGENT_MODEL_SMALL: 'small-model-id',
  AGENT_MODEL_LARGE: 'large-model-id',
  AGENT_HARNESS: 'loop',
  AUTO_ACCEPT_ENABLED: 'false',
  AUTO_ACCEPT_MAX_PAISE: '100000',
  DEMO_MODE: 'true',
  DAILY_LLM_BUDGET_USD: '5',
  AGENT_KILL_SWITCH: 'false',
});

function issuesOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    loadEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('parses a valid synthetic-mode environment into typed values', () => {
    const env = loadEnv(validEnv());
    expect(env).toMatchObject({
      PORT: 3000,
      RAZORPAY_SOURCE: 'synthetic',
      AGENT_HARNESS: 'loop',
      AUTO_ACCEPT_ENABLED: false,
      AUTO_ACCEPT_MAX_PAISE: 100000n,
      AUTO_ACCEPT_MIN_CONFIDENCE: 0.85,
      DEMO_MODE: true,
      DAILY_LLM_BUDGET_USD: 5,
      AGENT_KILL_SWITCH: false,
    });
    expect(env.RAZORPAY_KEY_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('defaults IMPORT_MAX_BYTES to 25 MiB, accepts a custom size and rejects nonsense', () => {
    expect(loadEnv(validEnv()).IMPORT_MAX_BYTES).toBe(26_214_400);
    expect(loadEnv({ ...validEnv(), IMPORT_MAX_BYTES: '' }).IMPORT_MAX_BYTES).toBe(26_214_400);
    expect(loadEnv({ ...validEnv(), IMPORT_MAX_BYTES: '5000000' }).IMPORT_MAX_BYTES).toBe(
      5_000_000,
    );
    for (const bad of ['abc', '1.5', '100', '104857601', '-5']) {
      const issues = issuesOf({ ...validEnv(), IMPORT_MAX_BYTES: bad });
      expect(
        issues.filter((issue) => issue.startsWith('IMPORT_MAX_BYTES')),
        bad,
      ).toHaveLength(1);
    }
  });

  it('defaults PORT to 3000 and treats blank optional values as unset', () => {
    const { PORT: _port, ...rest } = validEnv();
    const env = loadEnv({ ...rest, RAZORPAY_KEY_ID: '', ANTHROPIC_API_KEY: '   ' });
    expect(env.PORT).toBe(3000);
    expect(env.RAZORPAY_KEY_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('fails fast on an empty environment, naming every required variable', () => {
    const issues = issuesOf({});
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'RAZORPAY_SOURCE',
      'SYNTHETIC_DATA_DIR',
      'AGENT_MODEL_SMALL',
      'AGENT_MODEL_LARGE',
      'AGENT_HARNESS',
      'AUTO_ACCEPT_ENABLED',
      'AUTO_ACCEPT_MAX_PAISE',
      'DEMO_MODE',
      'DAILY_LLM_BUDGET_USD',
      'AGENT_KILL_SWITCH',
    ]) {
      expect(issues, name).toContainEqual(`${name}: is required`);
    }
    expect(issues.some((issue) => issue.startsWith('PORT'))).toBe(false);
    expect(issues.some((issue) => issue.startsWith('ANTHROPIC_API_KEY'))).toBe(false);
  });

  it('rejects malformed values', () => {
    const issues = issuesOf({
      ...validEnv(),
      AUTO_ACCEPT_MAX_PAISE: '10.5',
      DAILY_LLM_BUDGET_USD: '-1',
      AGENT_HARNESS: 'sideways',
      DEMO_MODE: 'yes',
      PORT: '70000',
      DATABASE_URL: 'mysql://nope',
    });
    expect(issues.map((issue) => issue.split(':')[0]).sort()).toEqual([
      'AGENT_HARNESS',
      'AUTO_ACCEPT_MAX_PAISE',
      'DAILY_LLM_BUDGET_USD',
      'DATABASE_URL',
      'DEMO_MODE',
      'PORT',
    ]);
  });

  describe('razorpay test-mode guard', () => {
    const LIVE_KEY = 'rzp_live_SuperSecret123';

    it('refuses a rzp_live_ key id', () => {
      const issues = issuesOf({ ...validEnv(), RAZORPAY_KEY_ID: LIVE_KEY });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^RAZORPAY_KEY_ID: live keys \(rzp_live_\*\) are forbidden/);
    });

    it('refuses a rzp_live_ key id in testmode too', () => {
      const issues = issuesOf({
        ...validEnv(),
        RAZORPAY_SOURCE: 'testmode',
        RAZORPAY_KEY_ID: LIVE_KEY,
        RAZORPAY_KEY_SECRET: 'secret',
      });
      expect(issues.some((issue) => /^RAZORPAY_KEY_ID: live keys/.test(issue))).toBe(true);
    });

    it('refuses regardless of case or surrounding whitespace', () => {
      for (const key of ['RZP_LIVE_abc', '  rzp_live_abc  ', 'Rzp_Live_abc']) {
        const issues = issuesOf({ ...validEnv(), RAZORPAY_KEY_ID: key });
        expect(
          issues.some((issue) => /^RAZORPAY_KEY_ID: live keys/.test(issue)),
          key,
        ).toBe(true);
      }
    });

    it('still reports the live key when other variables are also invalid', () => {
      const issues = issuesOf({ RAZORPAY_KEY_ID: LIVE_KEY });
      expect(issues.some((issue) => /^RAZORPAY_KEY_ID: live keys/.test(issue))).toBe(true);
      expect(issues).toContainEqual('DATABASE_URL: is required');
    });

    it('never echoes the key into the error message', () => {
      try {
        loadEnv({ ...validEnv(), RAZORPAY_KEY_ID: LIVE_KEY });
        expect.unreachable('loadEnv should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        expect((err as Error).message).not.toContain(LIVE_KEY);
        expect((err as Error).message).not.toContain('SuperSecret123');
      }
    });

    it('accepts a rzp_test_ key pair in testmode', () => {
      const env = loadEnv({
        ...validEnv(),
        RAZORPAY_SOURCE: 'testmode',
        RAZORPAY_KEY_ID: 'rzp_test_abc123',
        RAZORPAY_KEY_SECRET: 'secret',
      });
      expect(env.RAZORPAY_KEY_ID).toBe('rzp_test_abc123');
    });

    it('requires both keys in testmode', () => {
      const issues = issuesOf({ ...validEnv(), RAZORPAY_SOURCE: 'testmode' });
      expect(issues).toEqual([
        'RAZORPAY_KEY_ID: is required when RAZORPAY_SOURCE=testmode',
        'RAZORPAY_KEY_SECRET: is required when RAZORPAY_SOURCE=testmode',
      ]);
    });

    it('rejects a key id that is not rzp_test_ in testmode', () => {
      const issues = issuesOf({
        ...validEnv(),
        RAZORPAY_SOURCE: 'testmode',
        RAZORPAY_KEY_ID: 'abc123',
        RAZORPAY_KEY_SECRET: 'secret',
      });
      expect(issues).toEqual(['RAZORPAY_KEY_ID: must start with rzp_test_ (test mode only)']);
    });
  });
});

describe('investigation agent settings', () => {
  it('default to: no clustering, escalation on, worker on, 4 at a time', () => {
    expect(loadEnv(validEnv())).toMatchObject({
      CLUSTER_EXCEPTIONS: false,
      AGENT_ESCALATION: true,
      AGENT_WORKER_ENABLED: true,
      AGENT_CONCURRENCY: 4,
    });
  });

  it('can be set, and blank means the default', () => {
    const env = loadEnv({
      ...validEnv(),
      CLUSTER_EXCEPTIONS: 'true',
      AGENT_ESCALATION: 'false',
      AGENT_WORKER_ENABLED: 'false',
      AGENT_CONCURRENCY: '16',
    });
    expect(env).toMatchObject({
      CLUSTER_EXCEPTIONS: true,
      AGENT_ESCALATION: false,
      AGENT_WORKER_ENABLED: false,
      AGENT_CONCURRENCY: 16,
    });
    expect(loadEnv({ ...validEnv(), CLUSTER_EXCEPTIONS: '', AGENT_CONCURRENCY: '' })).toMatchObject(
      {
        CLUSTER_EXCEPTIONS: false,
        AGENT_CONCURRENCY: 4,
      },
    );
  });

  it.each([
    ['CLUSTER_EXCEPTIONS', 'yes'],
    ['AGENT_ESCALATION', '1'],
    ['AGENT_CONCURRENCY', '0'],
    ['AGENT_CONCURRENCY', '33'],
    ['AGENT_CONCURRENCY', '2.5'],
    ['AGENT_CONCURRENCY', 'many'],
  ])('rejects %s=%s', (name, value) => {
    const issues = issuesOf({ ...validEnv(), [name]: value });
    expect(issues.filter((i) => i.startsWith(name))).toHaveLength(1);
  });
});

describe('AUTO_ACCEPT_MIN_CONFIDENCE', () => {
  const withValue = (value: string | undefined) => ({
    ...validEnv(),
    AUTO_ACCEPT_MIN_CONFIDENCE: value,
  });

  it('defaults to 0.85 when left out or blank', () => {
    expect(loadEnv(validEnv()).AUTO_ACCEPT_MIN_CONFIDENCE).toBe(0.85);
    expect(loadEnv(withValue('')).AUTO_ACCEPT_MIN_CONFIDENCE).toBe(0.85);
  });

  it.each([
    ['0', 0],
    ['0.5', 0.5],
    ['0.9', 0.9],
    ['0.9999', 0.9999],
    ['1', 1],
    ['1.0', 1],
  ])('accepts %s', (text, value) => {
    expect(loadEnv(withValue(text)).AUTO_ACCEPT_MIN_CONFIDENCE).toBe(value);
  });

  it.each(['1.1', '2', '-0.1', '.5', '0.85555', 'high', '85%', '1e-1'])('refuses %s', (text) => {
    expect(issuesOf(withValue(text)).join(' ')).toContain('AUTO_ACCEPT_MIN_CONFIDENCE');
  });
});
