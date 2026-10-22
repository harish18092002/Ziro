// Test support for verification and review: valid orders and payouts that can be bent one field at a
// time, and proposals about them. The defaults are a correct match, so a test states only what it breaks.
import type { ReasonCode, RecordRef } from '@ziro/core/domain';
import {
  insertBankLine,
  insertException,
  insertLedger,
  insertPayment,
  insertProposal,
  insertSettlement,
  insertSettlementItem,
  type TestDb,
} from '../db/migrated-db.fixtures.js';

export { createMigratedDb, seedRun, type TestDb } from '../db/migrated-db.fixtures.js';

let n = 0;
const next = () => ++n;

export interface Order {
  readonly ledger: string;
  readonly payment: string;
  readonly links: RecordRef[];
}

/** A ledger entry and a captured payment for the same amount, one day apart: a correct order match. */
export async function seedOrder(
  db: TestDb,
  runId: string,
  over: {
    ledgerAmount?: bigint;
    paymentAmount?: bigint;
    ledgerDate?: string;
    paymentDate?: string;
    currency?: string;
    captured?: boolean;
  } = {},
): Promise<Order> {
  const id = next();
  const ledger = await insertLedger(db, runId, {
    orderRef: `RV-${id}`,
    amountPaise: over.ledgerAmount ?? 250_000n,
    businessDate: over.ledgerDate ?? '2026-10-21',
  });
  const payment = await insertPayment(db, runId, {
    rzpId: `pay_rv${id}`,
    receipt: `RV-${id}`,
    amountPaise: over.paymentAmount ?? 250_000n,
    businessDate: over.paymentDate ?? '2026-10-21',
    currency: over.currency ?? 'INR',
    captured: over.captured ?? true,
    status: over.captured === false ? 'authorized' : 'captured',
  });
  return {
    ledger,
    payment,
    links: [
      { recordType: 'ledger_entry', recordId: ledger },
      { recordType: 'rzp_payment', recordId: payment },
    ],
  };
}

export interface Payout {
  readonly settlement: string;
  readonly bank: string;
  readonly payments: string[];
  readonly amount: bigint;
  readonly links: RecordRef[];
}

/** A settlement of two payments (each 100,000 with a 2,000 fee) and the bank credit it landed as. */
export async function seedPayout(
  db: TestDb,
  runId: string,
  over: {
    bankAmount?: bigint;
    bankDate?: string;
    settlementDate?: string;
    direction?: 'credit' | 'debit';
  } = {},
): Promise<Payout> {
  const id = next();
  const payments: string[] = [];
  const rzpIds: string[] = [];
  for (const k of [1, 2]) {
    const rzpId = `pay_po${id}x${k}`;
    rzpIds.push(rzpId);
    payments.push(
      await insertPayment(db, runId, {
        rzpId,
        receipt: `PO-${id}-${k}`,
        amountPaise: 100_000n,
        feePaise: 2_000n,
        taxPaise: 305n,
        businessDate: '2026-10-21',
      }),
    );
  }
  const amount = 2n * (100_000n - 2_000n);
  const settlement = await insertSettlement(db, runId, {
    rzpId: `setl_po${id}`,
    amountPaise: amount,
    businessDate: over.settlementDate ?? '2026-10-23',
  });
  for (const [k, rzpId] of rzpIds.entries()) {
    await insertSettlementItem(db, runId, settlement, {
      itemType: 'payment',
      rzpEntityId: rzpId,
      paymentId: payments[k],
      amountPaise: 100_000n,
      feePaise: 2_000n,
      taxPaise: 305n,
      debitPaise: 0n,
      creditPaise: 98_000n,
    });
  }
  const bank = await insertBankLine(db, runId, {
    amountPaise: over.bankAmount ?? amount,
    valueDate: over.bankDate ?? '2026-10-24',
    direction: over.direction ?? 'credit',
  });
  return {
    settlement,
    bank,
    payments,
    amount,
    links: [
      { recordType: 'rzp_settlement', recordId: settlement },
      { recordType: 'bank_line', recordId: bank },
    ],
  };
}

export interface Proposal {
  readonly exceptionId: string;
  readonly proposalId: string;
}

/** An exception awaiting review, with an agent proposal about it (verification still pending). */
export async function seedProposal(
  db: TestDb,
  runId: string,
  links: RecordRef[],
  over: {
    verdict?: 'MATCH_PROPOSED' | 'EXPLAINED_NO_MATCH' | 'NEEDS_HUMAN';
    reasonCode?: ReasonCode;
    confidencePermille?: number;
    suggestedAction?: 'ACCEPT_MATCH' | 'NONE' | 'REFUND_CUSTOMER';
    amountAtStake?: bigint;
    subject?: RecordRef;
    exceptionStatus?: 'open' | 'proposed' | 'resolved' | 'dismissed';
  } = {},
): Promise<Proposal> {
  const subject = over.subject ?? links[0];
  if (subject === undefined) throw new Error('a proposal needs a subject');
  const exceptionId = await insertException(db, runId, {
    reasonCode: 'UNKNOWN',
    subjectType: subject.recordType,
    subjectId: subject.recordId,
    candidates: links.slice(1),
    status: over.exceptionStatus ?? 'proposed',
    amountAtStakePaise: over.amountAtStake ?? 250_000n,
    cause: 'receipt_ambiguous',
    note: 'seeded for a test',
  });
  const verdict = over.verdict ?? 'MATCH_PROPOSED';
  const proposalId = await insertProposal(db, runId, exceptionId, {
    verdict,
    reasonCode: over.reasonCode ?? 'UNKNOWN',
    links: verdict === 'NEEDS_HUMAN' ? [] : links,
    confidencePermille: over.confidencePermille ?? 900,
    suggestedAction:
      over.suggestedAction ?? (verdict === 'MATCH_PROPOSED' ? 'ACCEPT_MATCH' : 'NONE'),
    explanation: 'Seeded for a test.',
    evidence:
      verdict === 'NEEDS_HUMAN'
        ? []
        : [{ tool: 'get_exception', args: { exception_id: exceptionId }, keyFinding: 'seeded' }],
  });
  return { exceptionId, proposalId };
}
