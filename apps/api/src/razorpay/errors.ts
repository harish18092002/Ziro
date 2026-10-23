/** Statuses worth another attempt: no response at all (0), a timeout, rate limiting, server faults. */
export const isRetryableStatus = (statusCode: number): boolean =>
  statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode >= 500;

/**
 * An error response from Razorpay, or a failure to get one (statusCode 0: timeout, dropped
 * connection). Built from the SDK's `{ statusCode, error }` shape and nothing else, so it can never
 * carry credentials or request headers.
 */
export class RazorpayApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly description: string,
    readonly retryAfterMs: number | null = null,
    readonly attempts = 1,
  ) {
    super(`Razorpay API error ${statusCode} ${code}: ${description}`);
    this.name = 'RazorpayApiError';
  }

  get retryable(): boolean {
    return isRetryableStatus(this.statusCode);
  }

  /** For a person: what Razorpay said and how hard we tried. Carries nothing but the status and code. */
  get summary(): string {
    return `${this.message} (after ${this.attempts === 1 ? '1 try' : `${this.attempts} tries`})`;
  }

  withAttempts(attempts: number): RazorpayApiError {
    return new RazorpayApiError(
      this.statusCode,
      this.code,
      this.description,
      this.retryAfterMs,
      attempts,
    );
  }
}

/** Razorpay answered, but not in a shape we can use. Names the entity, never dumps the payload. */
export class RazorpayResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RazorpayResponseError';
  }
}

/** A record could not become a domain record (e.g. a captured payment with no fee). */
export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/** The source was set up wrongly: a live key, a missing secret, a missing data directory. */
export class RazorpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RazorpayConfigError';
  }
}
