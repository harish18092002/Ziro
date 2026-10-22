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
}
export interface Progress {
  stage: 'matching' | 'investigating' | 'ready' | 'failed' | 'unknown';
  agent: string | null;
  error: string | null;
  expected: number | null;
  note: string | null;
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
  run: { id: string; status: string; preset: string | null; featured: string | null };
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
  }[];
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
  proposal: {
    id: string;
    verdict: string;
    confidence: number;
    verifier: string;
    author: 'scripted' | 'planted' | 'model';
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
  author: 'scripted' | 'planted' | 'model';
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
