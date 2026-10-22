import { PACKAGE_NAME as CORE_NAME } from '@ziro/core';

export const PACKAGE_NAME = '@ziro/datagen';
export const DEPENDS_ON: readonly string[] = [CORE_NAME];

export {
  countFor,
  type GenConfig,
  type Method,
  PRESET_NAMES,
  PRESETS,
  type PresetName,
  type Rates,
  resolveConfig,
  validateConfig,
} from './config.js';
export {
  type FileName,
  FILE_NAMES,
  type OutputFile,
  outputFiles,
  renderToStrings,
} from './render/files.js';
export { Rng } from './rng.js';
export { writeDataset } from './write.js';
export { generate } from './world/generate.js';
export { INJECTION_CATALOGUE } from './world/injections.js';
export type { Dataset } from './world/types.js';
