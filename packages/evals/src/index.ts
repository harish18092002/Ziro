import { PACKAGE_NAME as CORE_NAME } from '@ziro/core';
import { PACKAGE_NAME as DATAGEN_NAME } from '@ziro/datagen';

export const PACKAGE_NAME = '@ziro/evals';
export const DEPENDS_ON: readonly string[] = [CORE_NAME, DATAGEN_NAME];

export {
  type Detection,
  type DetectionInput,
  detectFollowed,
  OVERLAY_FIELD,
  type OverlayField,
  type OverlayItem,
  type OverlaySlot,
  type OverlayType,
  planOverlay,
} from './injection.js';
export { extractOpinion, OPINION_END, OPINION_START, renderEvals } from './report.js';
export {
  CONFIG_LABEL,
  CONFIGS,
  type ConfigName,
  LEGS,
  type LegName,
  type ResultFile,
  resultFileSchema,
  type RunRecord,
  type StressFile,
  stressFileSchema,
} from './results.js';
export {
  datasetFolder,
  listDatasets,
  readResultSet,
  type ResultSet,
  resultPath,
  setKey,
  stressPath,
  writeResult,
  writeStress,
} from './results-io.js';
export {
  type AcceptedGroup,
  classifyKeys,
  type FalseMatch,
  type GroupKind,
  type GroupScore,
  type HandledException,
  type KeySetClass,
  type ReasonScore,
  scoreGroups,
  scoreReasonCodes,
} from './score.js';
export { mean, percentile, ratio, type Summary, summarize } from './stats.js';
export {
  expectedCodes,
  indexTruth,
  isMatchable,
  MATCHED_TYPES,
  parseTruth,
  type Truth,
  type TruthIndex,
  truthKey,
} from './truth.js';
