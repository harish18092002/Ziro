// The shapes the API returns, as the console uses them. Money is a digit string of paise.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: number | null,
    /** The whole answer, for the few errors that carry more than a message (a rejected CSV's report). */
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

/** What to tell a person: a rejected file's own reasons, else the server's message, else the error's text. */
export function reasonOf(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { fatal?: unknown } | null;
    const fatal = body?.fatal;
    if (Array.isArray(fatal) && fatal.length > 0) return fatal.map(String).join('; ');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function send<T>(method: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { method, ...init });
  const text = await res.text();
  let data: unknown = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = text; // not JSON (a proxy's error page, say): keep it as text rather than crash
    }
  }
  if (!res.ok) {
    const message =
      (data as { message?: string | string[] } | null)?.message ??
      `${res.status} ${res.statusText}`;
    const retry = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      res.status,
      Array.isArray(message) ? message.join('; ') : message,
      Number.isFinite(retry) && retry > 0 ? retry : null,
      data,
    );
  }
  return data as T;
}

const call = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  send<T>(
    method,
    path,
    body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

export const get = <T>(path: string): Promise<T> => call<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}): Promise<T> =>
  call<T>('POST', path, body);
/** A CSV as multipart/form-data in the field the server reads, `file`. */
export const upload = <T>(path: string, file: File): Promise<T> => {
  const form = new FormData();
  form.append('file', file);
  return send<T>('POST', path, { body: form });
};

// --- the test-mode workflow ----------------------------------------------------------------------

/** Which Razorpay source the server uses, and whether test mode and manual imports are switched on. */
export interface RazorpayStatus {
  source: 'synthetic' | 'testmode';
  ready: boolean;
  keyId: string | null;
  importsOpen: boolean;
}
export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}
export interface CsvReport {
  status: 'ok' | 'partial' | 'rejected';
  fileName: string | null;
  rows: {
    total: number;
    valid: number;
    inserted: number;
    unchanged: number;
    conflicts: number;
    rejected: number;
  };
  errorCount: number;
  errors: { row: number; field: string | null; reason: string }[];
  warnings: { reason: string }[];
  fatal: string[];
}
export interface RazorpayReport {
  status: 'ok' | 'partial' | 'rejected';
  entities: Record<string, { fetched: number; inserted: number; unchanged: number }>;
  provenance: { entity: string; source: string; requests: number }[];
  partial: boolean;
  gaps: { detail: string }[];
  warnings: { reason: string }[];
}
export interface StarterSummary {
  ledger: {
    rows: number;
    skipped: {
      notCaptured: number;
      noReceipt: number;
      otherCurrency: number;
      repeatOfAnOrder: number;
    };
  };
  bank: { rows: number; withoutUtr: number };
}
export interface MatchResult {
  groups: number;
  exceptions: number;
  ignored: number;
}
/** One payment in the test account, as the live list shows it. Money is a digit string of paise. */
export interface TestPayment {
  paymentId: string;
  orderId: string | null;
  receipt: string | null;
  method: string;
  /** Razorpay's own word: created, authorized, captured, refunded or failed. */
  status: string;
  captured: boolean;
  amountPaise: string;
  amountRefundedPaise: string;
  refundablePaise: string;
  canRefund: boolean;
  cannotRefundBecause: string | null;
  createdAt: string;
  businessDate: string;
}
export interface TestPaymentList {
  from: string;
  to: string;
  keyId: string | null;
  fetchedAt: string;
  payments: TestPayment[];
  truncated: boolean;
  /** False when Razorpay stopped answering part-way: what is listed is real, the rest is missing. */
  complete: boolean;
  warnings: string[];
}
export interface RefundResult {
  refundId: string;
  paymentId: string;
  amountPaise: number;
}

export interface Availability {
  featured: { demo: string | null; eval: string | null };
  live: { available: boolean; reason: string | null };
  /** The fault-injection toggle; offered only when the server runs in DEMO_MODE. */
  chaos: { available: boolean; reason: string | null };
}

/** One model of the chain: usable, cooling, out of quota until a time, or switched off. */
export interface ModelStatus {
  id: string;
  provider: string;
  model: string;
  state: 'ok' | 'cooling' | 'quota_exhausted' | 'disabled';
  until: string | null;
  why: string | null;
  usedToday: number;
  limitPerDay: number | null;
}

/**
 * Whether the agent will take work. `paused` says why not (an operator switch); `exhausted` says no model in
 * the chain can answer right now. The rules run either way.
 */
export interface AgentStatus {
  configured: boolean;
  paused: { reason: string; message: string; since: string | null; until: string | null } | null;
  spentTodayUsd: string;
  dailyBudgetUsd: string;
  models: ModelStatus[];
  dropped: { id: string; why: string }[];
  exhausted: boolean;
  /** live (off), recorded as they come (record), or replayed from a record (replay). */
  cache: 'off' | 'record' | 'replay';
  tier: 'free' | 'paid';
}

/** Something the Razorpay import could not get; the run is PARTIAL while any is recorded. */
export interface Gap {
  entity: string;
  kind: 'not_fetched' | 'cut_short' | 'days_missing';
  detail: string;
  days: string[];
}

/** The three exceptions the demo toggle broke on purpose. */
export interface ChaosPlan {
  timeoutFor: string | null;
  malformedFor: string | null;
  quotaFor: string | null;
}
export interface Progress {
  stage: 'matching' | 'investigating' | 'ready' | 'failed' | 'unknown';
  agent: string | null;
  error: string | null;
  expected: number | null;
  note: string | null;
  chaos: ChaosPlan | null;
  counts: {
    groups: number;
    exceptions: number;
    proposals: number;
    verified: number;
    refused: number;
    waiting: number;
  };
}
export interface Overview {
  run: {
    id: string;
    status: string;
    preset: string | null;
    featured: string | null;
    /** Put away by "Reset demo": readable, no longer reviewable. */
    archived: boolean;
    asOf: string;
    partial: boolean;
    gaps: Gap[];
  };
  failures: {
    handedToAPerson: number;
    byReason: { reason: string; label: string; count: number }[];
    injected: ChaosPlan | null;
    note: string | null;
  };
  reconciles: boolean;
  sources: {
    ledger: { records: number; amountPaise: string };
    payments: { records: number; captured: number; capturedPaise: string; feesPaise: string };
    refunds: { records: number; amountPaise: string };
    settlements: { records: number; amountPaise: string };
    bank: {
      credits: { records: number; amountPaise: string };
      debits: { records: number; amountPaise: string };
    };
  };
  coverage: {
    type: string;
    total: number;
    matched: number;
    inException: number;
    ignored: number;
    matchRate: number | null;
    amountPaise: { total: string; matched: string; inException: string; ignored: string };
    reconciles: boolean;
  }[];
  resolution: {
    ruleGroups: number;
    agentMatchesApprovedByPerson: number;
    agentExplanationsApprovedByPerson: number;
    autoAccepted: number;
    rejectedByPerson: number;
    dismissed: number;
    waiting: number;
  };
  openExceptions: {
    asOf: string;
    count: number;
    oldestDays: number | null;
    byAge: { bucket: string; cases: number; stakePaise: string }[];
  };
  leakage: {
    contract: { source: 'run' | 'default'; gstBps: number };
    assessed: number;
    notAssessable: number;
    overchargedCount: number;
    excessPaise: string;
    excessBasePaise: string;
    excessGstPaise: string;
    undercharged: { count: number; shortfallPaise: string };
    byMethod: { method: string; assessed: number; overchargedCount: number; excessPaise: string }[];
    worst: {
      rzpId: string;
      method: string;
      expectedFeePaise: string;
      actualFeePaise: string;
      excessPaise: string;
    }[];
  };
  delays: {
    delayedCount: number;
    delayedPaise: string;
    delayed: {
      rzpId: string;
      amountPaise: string;
      dueDate: string | null;
      settlementDate: string;
      createdLate: boolean;
      creditLate: boolean;
      businessDaysLate: number;
    }[];
    overdueCount: number;
    overduePaise: string;
    overdue: { rzpId: string; amountPaise: string; expectedBy: string; daysOverdue: number }[];
  };
  journal: {
    vouchers: number;
    settlementsBooked: number;
    adjustmentsBooked: number;
    settlementsNotBooked: { count: number; paise: string };
    skipped: { rzpId: string; reason: string }[];
  };
  matching: {
    matchedRecords: number;
    byTier: { label: string; groups: number; records: number; share: number }[];
    approvedByPerson: number;
    autoAccepted: number;
  };
  gap: {
    gapPaise: string;
    openPaise: string;
    awaitingPaise: string;
    explainedPaise: string;
    cases: { open: number; awaiting: number; explained: number };
  };
  exceptionsByReason: {
    reasonCode: string;
    total: number;
    open: number;
    proposed: number;
    resolved: number;
    dismissed: number;
  }[];
  llm: { agent: string | null; calls: number; costUsd: string; latencyMs: number };
  time: { seconds: number | null };
}
export interface Described {
  type: string;
  id: string;
  key: string;
  amountPaise: string;
  date: string | null;
  detail: string;
}
/** `harness`: nobody's conclusion, the system handed the exception to a person. */
export type Author = 'scripted' | 'planted' | 'model' | 'harness';
export interface ExceptionRow {
  id: string;
  reasonCode: string;
  status: 'open' | 'proposed' | 'resolved' | 'dismissed';
  cause: string | null;
  note: string | null;
  amountAtStakePaise: string;
  subject: Described | null;
  candidates: number;
  listedForAPerson: boolean;
  /** Days from the subject record's date to the run's as-of date. */
  ageDays: number | null;
  /** The agent's suggested action, blank when it was refused or there is none. */
  suggestedAction: string | null;
  nextStep: string;
  proposal: {
    id: string;
    verdict: string;
    confidence: number;
    verifier: string;
    author: Author;
    /** Why the system handed this to a person without a conclusion; null when something concluded. */
    degraded: string | null;
    degradedLabel: string | null;
  } | null;
  review: { decision: string; reviewer: string } | null;
}
export interface ExceptionList {
  total: number;
  items: ExceptionRow[];
}
export interface ProposalDetail {
  id: string;
  attempt: number;
  author: Author;
  degraded: string | null;
  degradedLabel: string | null;
  model: string | null;
  verdict: string;
  reasonCode: string;
  confidence: number;
  suggestedAction: string;
  explanation: string;
  evidence: { tool: string; args: Record<string, unknown>; keyFinding: string }[];
  links: Described[];
  verifier: { status: string; findings: string[] };
  harnessFindings: string[];
  draftJournalEntry: {
    memo: string;
    lines: { account: string; debit: string; credit: string }[];
  } | null;
  review: { decision: string; reviewer: string; note: string | null; at: string } | null;
}
export interface ExceptionDetail {
  exception: ExceptionRow;
  subject: Described | null;
  candidates: Described[];
  proposals: ProposalDetail[];
}
export interface Timeline {
  record: { type: string; id: string; key: string; amountPaise: string; date: string };
  timeline: {
    id: string;
    at: string;
    actor: string;
    action: string;
    reason: string | null;
    after: unknown;
  }[];
  truncated: boolean;
}
