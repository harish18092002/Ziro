import { PACKAGE_NAME } from '@ziro/core';
import { describe, expect, it } from 'vitest';

describe('workspace wiring', () => {
  it('resolves @ziro/core through the npm workspace link', () => {
    expect(PACKAGE_NAME).toBe('@ziro/core');
  });
});
