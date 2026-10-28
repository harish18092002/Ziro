import { REASON_CODES } from '@ziro/core/domain';
import { describe, expect, it } from 'vitest';
import { REASON_LABELS, REASONS, reasonLabel } from './reasons';

describe('reasons', () => {
  it('describes exactly the reason codes the core defines', () => {
    expect(Object.keys(REASONS).sort()).toEqual([...REASON_CODES].sort());
    expect(Object.keys(REASON_LABELS).sort()).toEqual([...REASON_CODES].sort());
  });

  it('never shows the bare word UNKNOWN as a label', () => {
    expect(reasonLabel('UNKNOWN')).toBe('Unclassified discrepancy');
    for (const code of REASON_CODES) expect(reasonLabel(code)).not.toMatch(/^[A-Z_]+$/);
  });
});
