import { REASON_CODES } from '@ziro/core/domain';
import { describe, expect, it } from 'vitest';
import { REASONS } from './reasons';

describe('reasons', () => {
  it('describes exactly the reason codes the core defines', () => {
    expect(Object.keys(REASONS).sort()).toEqual([...REASON_CODES].sort());
  });
});
