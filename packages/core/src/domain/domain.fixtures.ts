// Test fixtures: valid *input* objects for each domain schema. Each call returns a fresh object.

/** A valid RFC 4122 v4 uuid derived from a small number. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const RUN_ID = uuid(1);
export const HASH = '0123456789abcdef'.repeat(4);

const source = (n: number, sourceRef: string) => ({
  id: uuid(n),
  runId: RUN_ID,
  source: 'synthetic',
  sourceRef,
  importHash: HASH,
});

export const ledgerEntryFixture = () => ({
  ...source(10, 'row-1'),
  orderRef: 'ORD-1001',
  amount: '250000',
  businessDate: '2026-10-21',
  customerRef: 'cust-77',
  memo: 'Diwali order',
});

export const rzpPaymentFixture = () => ({
  ...source(11, 'pay_Abc123'),
  paymentId: 'pay_Abc123',
  orderId: 'order_Xyz789',
  receipt: 'ORD-1001',
  amount: 250000, // Razorpay sends JSON integers
  fee: 5900n,
  tax: 900n,
  amountRefunded: '0',
  method: 'wallet',
  status: 'captured',
  captured: true,
  createdAt: '2026-10-21T18:45:00Z',
  businessDate: '2026-10-22', // 18:45Z is already the next day in IST
});

export const rzpRefundFixture = () => ({
  ...source(12, 'rfnd_Ref001'),
  refundId: 'rfnd_Ref001',
  paymentId: 'pay_Abc123',
  amount: 50000,
  status: 'processed',
  createdAt: '2026-10-22T04:30:00+05:30',
  businessDate: '2026-10-22',
});

export const rzpSettlementFixture = () => ({
  ...source(13, 'setl_Set001'),
  settlementId: 'setl_Set001',
  amount: '9973635',
  fees: 0,
  tax: 0,
  utr: 'UTIB0123456789',
  status: 'processed',
  createdAt: '2026-10-23T06:00:00Z',
  businessDate: '2026-10-23',
});

export const settlementItemFixture = () => ({
  ...source(14, 'recon-0001'),
  settlementId: 'setl_Set001',
  itemType: 'payment',
  entityId: 'pay_Abc123',
  paymentId: 'pay_Abc123',
  orderId: 'order_Xyz789',
  amount: 250000,
  fee: 5900,
  tax: 900,
  debit: 0,
  credit: 244100,
  settledAt: '2026-10-23T06:00:00Z',
  description: null,
});

export const bankLineFixture = () => ({
  ...source(15, 'stmt-0042'),
  valueDate: '2026-10-23',
  direction: 'credit',
  amount: '9973635',
  narration: 'NEFT CR UTIB0123456789 RAZORPAY SOFTWARE',
  utr: 'UTIB0123456789',
  utrQuality: 'exact',
  balance: '1234567800',
});

export const matchGroupFixture = () => ({
  id: uuid(20),
  runId: RUN_ID,
  kind: 'payout',
  status: 'accepted',
  basis: 'rule',
  tier: 'T2',
  reasonCode: 'BATCHED_SETTLEMENT',
  residual: '0',
  createdAt: '2026-10-23T07:00:00Z',
});

export const matchLinkFixture = () => ({
  id: uuid(21),
  groupId: uuid(20),
  groupStatus: 'accepted',
  recordType: 'bank_line',
  recordId: uuid(15),
});

export const reconExceptionFixture = () => ({
  id: uuid(30),
  runId: RUN_ID,
  reasonCode: 'FEE_GST_DEDUCTION',
  status: 'open',
  subject: { recordType: 'rzp_payment', recordId: uuid(11) },
  candidates: [{ recordType: 'ledger_entry', recordId: uuid(10) }],
  amountAtStake: '-6800',
  createdAt: '2026-10-23T07:00:00Z',
});

export const agentProposalContentFixture = () => ({
  exceptionId: uuid(30),
  reasonCode: 'FEE_GST_DEDUCTION',
  links: [
    { recordType: 'ledger_entry', recordId: uuid(10) },
    { recordType: 'rzp_payment', recordId: uuid(11) },
  ],
  claimedResidual: '0',
  explanation: 'Payment 250000 less fee 5900 (incl. GST 900) matches the ledger order.',
  evidence: [
    { ref: { recordType: 'rzp_payment', recordId: uuid(11) }, field: 'fee', value: '5900' },
  ],
});

export const agentProposalFixture = () => ({
  id: uuid(31),
  runId: RUN_ID,
  llmCallId: uuid(40),
  ...agentProposalContentFixture(),
  verifierStatus: 'pending',
  verifierFindings: [],
  createdAt: '2026-10-23T07:05:00Z',
});

export const reviewFixture = () => ({
  id: uuid(32),
  runId: RUN_ID,
  proposalId: uuid(31),
  decision: 'approved',
  reviewerKind: 'human',
  reviewer: 'asha',
  note: null,
  createdAt: '2026-10-23T07:10:00Z',
});

export const auditEventFixture = () => ({
  id: '42',
  runId: RUN_ID,
  at: '2026-10-23T07:10:00Z',
  actor: 'human',
  action: 'proposal.approved',
  entityType: 'agent_proposal',
  entityId: uuid(31),
  detail: { residual: '0', note: null, links: 2 },
});
