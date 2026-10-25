// What can go wrong when asking a language model, in words that mean the same for every provider. An
// adapter turns each SDK failure into exactly one of these; what to do about it (wait, try the next model,
// switch a provider off) is the router's decision, not the adapter's.
//
//   RATE_LIMITED     too many requests too fast; waiting `retryAfterMs` (when known) helps
//   QUOTA_EXHAUSTED  a usage or spend allowance is used up; waiting a little does not help
//   BILLING          no credit or no billing set up: every call to this provider will fail alike
//   AUTH             the key is wrong, revoked or not allowed: same, for every call
//   TIMEOUT          the provider did not answer in time
//   SERVER           the provider is failing or unreachable (5xx, overloaded, connection error)
//   BAD_REQUEST      this request was refused (400-class); sending it again is pointless
//   SAFETY_BLOCKED   the provider's content filter stopped the answer
//   MALFORMED        the provider produced something unusable (a broken tool call, a reply that fails
//                    the schema); the caller may repair once
export const LLM_ERROR_KINDS = [
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'BILLING',
  'AUTH',
  'TIMEOUT',
  'SERVER',
  'BAD_REQUEST',
  'SAFETY_BLOCKED',
  'MALFORMED',
] as const;

export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

export interface LlmErrorDetails {
  readonly provider: string;
  readonly model: string;
  /** The HTTP status, when there was a response. */
  readonly status?: number | null;
  /** The provider's id for the request, for support and tracing. */
  readonly requestId?: string | null;
  /** How long the server asked us to wait. Meaningful for RATE_LIMITED. */
  readonly retryAfterMs?: number | null;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: string;
  readonly model: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(kind: LlmErrorKind, message: string, details: LlmErrorDetails) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status ?? null;
    this.requestId = details.requestId ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}
