import { ReasonCode } from '@ziro/core/domain';
import type { GenConfig } from '../config.js';
import { compareStrings } from '../util.js';
import { allRecords } from '../world/truth.js';
import type { AnomalyRec, Dataset } from '../world/types.js';
import { type Json, stringifyJson } from './json.js';

export const GENERATOR_VERSION = '1';

/** The config as plain JSON. Paise-valued settings are strings, like every paise in a JSON file. */
export function configJson(config: GenConfig): Json {
  return {
    preset: config.preset,
    seed: config.seed,
    orders: config.orders,
    startDate: config.startDate,
    days: config.days,
    tailDays: config.tailDays,
    fixedHolidays: [...config.fixedHolidays],
    methodWeights: { ...config.methodWeights },
    feeBps: { ...config.feeBps },
    gstBps: config.gstBps,
    settlementLagBusinessDays: config.settlementLagBusinessDays,
    rates: { ...config.rates },
    overchargeExtraBps: [...config.overchargeExtraBps],
    failedAttemptBps: config.failedAttemptBps,
    debitCapPaise: config.debitCapPaise.toString(),
    bank: {
      openingBalancePaise: config.bank.openingBalancePaise.toString(),
      noiseLines: config.bank.noiseLines,
      decoyBps: config.bank.decoyBps,
      lagOneDayBps: config.bank.lagOneDayBps,
      debitShareBps: config.bank.debitShareBps,
    },
    injections: config.injections,
    jsonIndent: config.jsonIndent,
  };
}

function counts(data: Dataset): Json {
  const anomalies: { [code: string]: Json } = {};
  for (const code of Object.values(ReasonCode)) anomalies[code] = 0;
  for (const anomaly of data.anomalies)
    anomalies[anomaly.code] = (anomalies[anomaly.code] as number) + 1;
  const byType: { [type: string]: Json } = {};
  for (const record of allRecords(data))
    byType[record.type] = ((byType[record.type] as number | undefined) ?? 0) + 1;
  return {
    records: byType,
    groups: {
      order: data.groups.filter((g) => g.kind === 'order').length,
      payout: data.groups.filter((g) => g.kind === 'payout').length,
    },
    anomalies,
    injections: [...allRecords(data)].filter((r) => r.label.injection !== null).length,
    failedAttempts: data.payments.filter((p) => p.status === 'failed').length,
  };
}

/**
 * truth.json: what really happened. Money is a string of paise. `reasonCodes` hold only INJECTED
 * causes (empty for a normal record); structural reasons (batching, fee deduction) sit on groups.
 * A `groupId` of null means a genuine leftover or pure noise. Written one element per line.
 */
export function* truthChunks(data: Dataset): Generator<string> {
  const anomalyById = new Map<string, AnomalyRec>(data.anomalies.map((a) => [a.id, a]));

  yield '{\n"meta": ';
  yield stringifyJson(
    {
      generator: '@ziro/datagen',
      generatorVersion: GENERATOR_VERSION,
      seed: data.config.seed,
      preset: data.config.preset,
      config: configJson(data.config),
      counts: counts(data),
    },
    2,
  );

  yield ',\n"groups": [\n';
  let first = true;
  for (const group of data.groups) {
    yield `${first ? '' : ',\n'}${stringifyJson(
      {
        id: group.id,
        kind: group.kind,
        members: group.members,
        structural: group.structural,
        anomalies: group.anomalies,
        composition: group.composition,
      },
      0,
    )}`;
    first = false;
  }

  yield '\n],\n"anomalies": [\n';
  first = true;
  for (const anomaly of data.anomalies) {
    yield `${first ? '' : ',\n'}${stringifyJson(
      {
        id: anomaly.id,
        reasonCode: anomaly.code,
        records: anomaly.records.map((r) => ({ type: r.type, key: r.key, role: r.role })),
        detail: anomaly.detail,
      },
      0,
    )}`;
    first = false;
  }

  yield '\n],\n"records": [\n';
  first = true;
  for (const record of allRecords(data)) {
    const codes = new Set<string>();
    for (const id of record.label.anomalyIds) {
      const anomaly = anomalyById.get(id);
      if (anomaly) codes.add(anomaly.code);
    }
    yield `${first ? '' : ',\n'}${stringifyJson(
      {
        type: record.type,
        key: record.key,
        groupId: record.label.groupId,
        role: record.label.role,
        reasonCodes: [...codes].sort(compareStrings),
        anomalyIds: record.label.anomalyIds,
        injection: record.label.injection
          ? {
              field: record.label.injection.field,
              style: record.label.injection.style,
              text: record.label.injection.text,
            }
          : null,
        ambiguousWith: record.label.ambiguousWith,
      },
      0,
    )}`;
    first = false;
  }
  yield '\n]\n}\n';
}
