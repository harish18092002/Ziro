import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { investigationJobSchema, jobKey } from './jobs.js';

const item = (attempt = 1) => ({ exceptionId: randomUUID(), attempt });
const job = (items = [item()], clusterId: string | null = null) => ({
  runId: randomUUID(),
  clusterId,
  items,
});

describe('investigationJobSchema', () => {
  it('accepts one to six exceptions', () => {
    for (const n of [1, 6]) {
      const items = Array.from({ length: n }, () => item());
      expect(investigationJobSchema.safeParse(job(items)).success).toBe(true);
    }
  });

  it('refuses none, seven, a bad attempt, a bad id and unknown keys', () => {
    expect(investigationJobSchema.safeParse(job([])).success).toBe(false);
    const seven = Array.from({ length: 7 }, () => item());
    expect(investigationJobSchema.safeParse(job(seven)).success).toBe(false);
    expect(investigationJobSchema.safeParse(job([item(0)])).success).toBe(false);
    expect(investigationJobSchema.safeParse(job([item(1.5)])).success).toBe(false);
    expect(investigationJobSchema.safeParse({ ...job(), runId: 'nope' }).success).toBe(false);
    expect(investigationJobSchema.safeParse({ ...job(), extra: 1 }).success).toBe(false);
  });
});

describe('jobKey', () => {
  it('is the exception and attempt for a single job, so a re-run is a different job', () => {
    const one = item(1);
    expect(jobKey(job([one]))).toBe(`${one.exceptionId}-1`);
    expect(jobKey(job([{ ...one, attempt: 2 }]))).toBe(`${one.exceptionId}-2`);
    expect(jobKey(job([one]))).toBe(jobKey(job([one])));
  });

  it('is the cluster id for a cluster', () => {
    const clusterId = randomUUID();
    expect(jobKey(job([item(), item()], clusterId))).toBe(`cluster-${clusterId}`);
  });

  it('never contains a colon, which BullMQ forbids in a custom id', () => {
    expect(jobKey(job([item(3)]))).not.toContain(':');
    expect(jobKey(job([item(), item()], randomUUID()))).not.toContain(':');
    expect(jobKey(job([item(), item()], null))).not.toContain(':');
  });
});
