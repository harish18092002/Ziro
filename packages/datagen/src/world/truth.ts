import type { ReasonCode } from '@ziro/core/domain';
import { add, type Paise, ZERO } from '@ziro/core/money';
import { compareStrings, pad } from '../util.js';
import { type Dataset, type GroupRec, type Label, type RecordType, recordKey } from './types.js';

export interface TruthRecord {
  readonly type: RecordType;
  readonly key: string;
  readonly label: Label;
}

/** Every record of a dataset with its type, key and label, in one fixed order. */
export function* allRecords(data: Dataset): Generator<TruthRecord> {
  for (const r of data.ledger) yield { type: 'ledger_entry', key: r.orderRef, label: r.label };
  for (const r of data.orders) yield { type: 'rzp_order', key: r.id, label: r.label };
  for (const r of data.payments) yield { type: 'rzp_payment', key: r.id, label: r.label };
  for (const r of data.refunds) yield { type: 'rzp_refund', key: r.id, label: r.label };
  for (const r of data.settlements) yield { type: 'rzp_settlement', key: r.id, label: r.label };
  for (const r of data.items)
    yield { type: 'settlement_item', key: `${r.settlementId}:${r.entityId}`, label: r.label };
  for (const r of data.bank) yield { type: 'bank_line', key: `row-${r.rowNumber}`, label: r.label };
}

/**
 * Turns the generated records into ground truth: numbers the anomalies, stamps each record with the
 * anomalies it takes part in, and builds the order and payout groups with exact-paise composition.
 */
export function finalizeTruth(data: Dataset): void {
  data.anomalies.forEach((anomaly, index) => {
    anomaly.id = `AN-${pad(index + 1, 6)}`;
  });

  const labelOf = new Map<string, Label>();
  for (const record of allRecords(data))
    labelOf.set(recordKey(record.type, record.key), record.label);

  const groupAnomalies = new Map<string, Set<ReasonCode>>();
  for (const anomaly of data.anomalies) {
    for (const member of anomaly.records) {
      const label = labelOf.get(recordKey(member.type, member.key));
      if (!label)
        throw new Error(
          `anomaly ${anomaly.id} names a record that does not exist: ${member.type}:${member.key}`,
        );
      label.anomalyIds.push(anomaly.id);
      if (label.groupId !== null) {
        const codes = groupAnomalies.get(label.groupId);
        if (codes) codes.add(anomaly.code);
        else groupAnomalies.set(label.groupId, new Set([anomaly.code]));
      }
    }
  }

  // Members per group, in the fixed record order.
  const members = new Map<string, string[]>();
  for (const record of allRecords(data)) {
    const { groupId } = record.label;
    if (groupId === null) continue;
    const list = members.get(groupId);
    const entry = recordKey(record.type, record.key);
    if (list) list.push(entry);
    else members.set(groupId, [entry]);
  }

  // Exact-paise composition.
  const sums = new Map<string, Record<string, Paise>>();
  const bucket = (groupId: string): Record<string, Paise> => {
    let b = sums.get(groupId);
    if (!b) sums.set(groupId, (b = {}));
    return b;
  };
  const bump = (groupId: string, field: string, value: Paise): void => {
    const b = bucket(groupId);
    b[field] = add(b[field] ?? ZERO, value);
  };
  const paymentItems = new Map<string, number>();

  for (const r of data.ledger) if (r.label.groupId) bump(r.label.groupId, 'ledger', r.amount);
  for (const r of data.payments) {
    if (!r.label.groupId || r.fee === null || r.tax === null) continue;
    bump(r.label.groupId, 'payments', r.amount);
    bump(r.label.groupId, 'fees', r.fee);
    bump(r.label.groupId, 'tax', r.tax);
  }
  for (const r of data.refunds) if (r.label.groupId) bump(r.label.groupId, 'refunds', r.amount);
  for (const r of data.settlements)
    if (r.label.groupId) bump(r.label.groupId, 'settlement', r.amount);
  for (const r of data.bank)
    if (r.label.groupId && r.credit !== null) bump(r.label.groupId, 'bank', r.credit);
  for (const r of data.items) {
    const groupId = r.label.groupId;
    if (!groupId) continue;
    if (r.type === 'payment') {
      bump(groupId, 'paymentsGross', r.amount);
      bump(groupId, 'feesDeducted', r.fee);
      paymentItems.set(groupId, (paymentItems.get(groupId) ?? 0) + 1);
    } else if (r.type === 'refund') bump(groupId, 'refundsDebited', r.debit);
    else if (r.type === 'adjustment') bump(groupId, 'adjustmentsDebited', r.debit);
  }

  const ids = [...members.keys()].sort(compareStrings);
  for (const id of ids) {
    const kind = id.startsWith('OG-') ? 'order' : 'payout';
    const structural: ReasonCode[] = [];
    if (kind === 'payout') {
      structural.push('FEE_GST_DEDUCTION');
      if ((paymentItems.get(id) ?? 0) >= 2) structural.push('BATCHED_SETTLEMENT');
    }
    const composition: Record<string, string> = {};
    for (const [field, value] of Object.entries(sums.get(id) ?? {}))
      composition[field] = value.toString();
    const group: GroupRec = {
      id,
      kind,
      members: members.get(id) ?? [],
      structural,
      anomalies: [...(groupAnomalies.get(id) ?? [])].sort(compareStrings),
      composition,
    };
    data.groups.push(group);
  }
}
