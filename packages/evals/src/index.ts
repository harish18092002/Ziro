import { PACKAGE_NAME as CORE_NAME } from '@ziro/core';
import { PACKAGE_NAME as DATAGEN_NAME } from '@ziro/datagen';

// Placeholder: the eval runner and metrics land in a later prompt.
export const PACKAGE_NAME = '@ziro/evals';
export const DEPENDS_ON: readonly string[] = [CORE_NAME, DATAGEN_NAME];
