import { describe, expect, it } from 'vitest';
import { DEPENDS_ON, PACKAGE_NAME } from './index.js';

describe('@ziro/datagen', () => {
  it('is wired into the workspace and resolves @ziro/core', () => {
    expect(PACKAGE_NAME).toBe('@ziro/datagen');
    expect(DEPENDS_ON).toEqual(['@ziro/core']);
  });
});
