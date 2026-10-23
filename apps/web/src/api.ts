// The shapes the API returns, as the console uses them. Money is a digit string of paise.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  const data: unknown = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    const message =
      (data as { message?: string | string[] } | null)?.message ??
      `${res.status} ${res.statusText}`;
    const retry = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      res.status,
      Array.isArray(message) ? message.join('; ') : message,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return data as T;
}
export const get = <T>(path: string): Promise<T> => call<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}): Promise<T> =>
  call<T>('POST', path, body);

export interface Availability {
  featured: { demo: string | null; eval: string | null };
  live: { available: boolean; reason: string | null };
  /** The fault-injection toggle; offered only when the server runs in DEMO_MODE. */
  chaos: { available: boolean; reason: string | null };
}

/** Whether the agent will take work. `paused` says why not; the rules run either way. */
export interface AgentStatus {
  configured: boolean;
  paused: { reason: string; message: string; since: string | null; until: string | null } | null;
  spentTodayUsd: string;
  dailyBudgetUsd: string;
}

/** Something the Razorpay import could not get; the run is PARTIAL while any is recorded. */
export interface Gap {
  entity: string;
  kind: 'not_fetched' | 'cut_short' | 'days_missing';
  detail: string;
  days: string[];
}

/** The two exceptions the demo toggle broke on purpose. */
export interface ChaosPlan {
  timeoutFor: string | null;
  malformedFor: string | null;
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
