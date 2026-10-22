import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@ziro/core', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@ziro/core');
  });
});
