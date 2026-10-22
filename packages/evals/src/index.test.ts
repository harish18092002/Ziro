import { describe, expect, it } from 'vitest';
import { DEPENDS_ON, PACKAGE_NAME } from './index.js';

describe('@ziro/evals', () => {
  it('is wired into the workspace and resolves its siblings', () => {
    expect(PACKAGE_NAME).toBe('@ziro/evals');
    expect(DEPENDS_ON).toEqual(['@ziro/core', '@ziro/datagen']);
  });
});
