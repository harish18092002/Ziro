// The only file that touches the Razorpay SDK. Read from the SDK's source (razorpay 2.9.8):
//  - the host is hard-coded to https://api.razorpay.com and there is no timeout option;
//  - its error handler does `err.response.status`, so a timeout or a dropped connection (where there
//    is no `response`) becomes an opaque TypeError, and response headers are discarded;
//  - it neither paginates nor retries.
// The SDK builds an axios instance and keeps it at `razorpay.api.rq` (public at runtime, absent from
// the type declarations). We use it to set a timeout, to turn network failures into the shape the
// SDK expects, and, in tests only, to swap the network. The version is pinned exactly, and a test
// fails loudly if any internal used here goes missing.
import { type AxiosAdapter, type AxiosInstance, type AxiosResponse, isAxiosError } from 'axios';
import Razorpay from 'razorpay';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import { DEFAULT_RETRY, REAL_DEPS, type RetryDeps, type RetryPolicy, withRetry } from './retry.js';

export interface ListQuery {
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly skip: number;
}

export interface ReconQuery {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly count: number;
  readonly skip: number;
}

/** What the sources need from Razorpay: raw JSON back, nothing interpreted, retries already done. */
export interface RazorpayClient {
  listPayments(query: ListQuery): Promise<unknown>;
  listOrders(query: ListQuery): Promise<unknown>;
  fetchOrder(orderId: string): Promise<unknown>;
  listRefunds(query: ListQuery): Promise<unknown>;
  listSettlements(query: ListQuery): Promise<unknown>;
  settlementRecon(query: ReconQuery): Promise<unknown>;
}

/**
 * What the "test payments" helper writes to YOUR Razorpay TEST account: an order to pay, and a refund of
 * a payment you made. Test keys only (the same check as the reads), and never retried: a repeated POST
 * could make a second order. It never touches anything the reads rely on.
 */
export interface RazorpayWriter {
  createOrder(input: {
    readonly amountPaise: number;
    readonly receipt: string;
    readonly notes?: Record<string, string>;
  }): Promise<unknown>;
  refundPayment(
    paymentId: string,
    input: { readonly amountPaise?: number; readonly notes?: Record<string, string> },
  ): Promise<unknown>;
}

export interface SdkClientOptions {
  readonly keyId: string;
  readonly keySecret: string;
  /** Per request, in milliseconds. Default 15 000. */
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly deps?: Partial<RetryDeps>;
  /** Test seams that replace the network. Never set in production code. */
  readonly adapter?: AxiosAdapter;
  readonly baseURL?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Test mode only, enforced where the key is first touched (the boot guard is the first defence). */
function assertTestKey(keyId: string, keySecret: string): void {
  if (/^rzp_live_/i.test(keyId)) {
    throw new RazorpayConfigError('live Razorpay keys are forbidden: Ziro is test mode only');
  }
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) {
    throw new RazorpayConfigError('the Razorpay key id must be a rzp_test_ key');
  }
  if (keySecret.trim() === '') throw new RazorpayConfigError('the Razorpay key secret is missing');
}

function retryAfterSeconds(headers: unknown): number | null {
  const raw = isRecord(headers) ? headers['retry-after'] : undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Runs before the SDK's own error handler. Guarantees every failure has `response.status` and
 * `response.data.error`, so the SDK throws `{ statusCode, error }` instead of crashing. No response
 * at all becomes statusCode 0. A Retry-After header is carried through in the error's metadata.
 */
function normalizeFailure(error: unknown): Promise<never> {
  if (!isAxiosError(error))
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));

  const response = error.response;
  const status = response?.status ?? 0;
  const data = isRecord(response?.data) ? response.data : {};
  const given = isRecord(data['error']) ? data['error'] : undefined;
  const metadata: Record<string, string> = isRecord(given?.['metadata'])
    ? { ...(given['metadata'] as Record<string, string>) }
    : {};

  const retryAfter = retryAfterSeconds(response?.headers);
  if (retryAfter !== null) metadata['retry_after_seconds'] = String(retryAfter);

  const normalized = {
    ...given,
    code:
      typeof given?.['code'] === 'string'
        ? given['code']
        : response
          ? 'BAD_RESPONSE'
          : (error.code ?? 'NETWORK_ERROR'),
    description:
      typeof given?.['description'] === 'string'
        ? given['description']
        : response
          ? `HTTP ${status} without a Razorpay error body`
          : error.message,
    metadata,
  };

  error.response = {
    status,
    statusText: response?.statusText ?? '',
    headers: response?.headers ?? {},
    config: error.config,
    data: { ...data, error: normalized },
  } as AxiosResponse;
  return Promise.reject(error);
}

/** Turns what the SDK throws (`{ statusCode, error }`) into a RazorpayApiError; passes anything else on. */
function toApiError(thrown: unknown): unknown {
  if (!isRecord(thrown) || typeof thrown['statusCode'] !== 'number' || !isRecord(thrown['error']))
    return thrown;
  const e = thrown['error'];
  const metadata = isRecord(e['metadata']) ? e['metadata'] : {};
  const retryAfter = Number(metadata['retry_after_seconds']);
  return new RazorpayApiError(
    thrown['statusCode'],
    typeof e['code'] === 'string' ? e['code'] : 'UNKNOWN',
    typeof e['description'] === 'string' ? e['description'] : '',
    Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
  );
}

/** The shared set-up: the test-key check, the SDK with a timeout and failure handling, and the retry wrapper. */
function prepare(options: SdkClientOptions, fixed: Partial<RetryPolicy> = {}) {
  assertTestKey(options.keyId, options.keySecret);

  const razorpay = new Razorpay({ key_id: options.keyId, key_secret: options.keySecret });

  const http = (razorpay as unknown as { api?: { rq?: AxiosInstance } }).api?.rq;
  if (!http || !http.defaults || typeof http.interceptors?.response?.use !== 'function') {
    throw new RazorpayConfigError(
      'the Razorpay SDK no longer exposes api.rq (axios): this adapter was written for razorpay 2.9.8',
    );
  }
  http.defaults.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.baseURL !== undefined) http.defaults.baseURL = options.baseURL;
  if (options.adapter !== undefined) http.defaults.adapter = options.adapter;
  http.interceptors.response.use(undefined, normalizeFailure);

  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry, ...fixed };
  const deps: RetryDeps = { ...REAL_DEPS, ...options.deps };
  const call = <T>(fn: () => Promise<T>): Promise<T> =>
    withRetry(
      async () => {
        try {
          return await fn();
        } catch (thrown) {
          throw toApiError(thrown);
        }
      },
      policy,
      deps,
    );
  return { razorpay, call };
}

/** Wraps the official SDK with a timeout, sane network-error handling, and retries with backoff. */
export function createSdkClient(options: SdkClientOptions): RazorpayClient {
  const { razorpay, call } = prepare(options);
  return {
    listPayments: (q) => call(() => razorpay.payments.all({ ...q })),
    listOrders: (q) => call(() => razorpay.orders.all({ ...q })),
    fetchOrder: (id) => call(() => razorpay.orders.fetch(id)),
    listRefunds: (q) => call(() => razorpay.refunds.all({ ...q })),
    listSettlements: (q) => call(() => razorpay.settlements.all({ ...q })),
    settlementRecon: (q) => call(() => razorpay.settlements.reports({ ...q })),
  };
}

/** The same wrapper for the two writes the test-payments helper needs. One attempt each, never retried. */
export function createSdkWriter(options: SdkClientOptions): RazorpayWriter {
  const { razorpay, call } = prepare(options, { maxAttempts: 1 });
  return {
    createOrder: (input) =>
      call(() =>
        razorpay.orders.create({
          amount: input.amountPaise,
          currency: 'INR',
          receipt: input.receipt,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        }),
      ),
    refundPayment: (paymentId, input) =>
      call(() =>
        razorpay.payments.refund(paymentId, {
          ...(input.amountPaise === undefined ? {} : { amount: input.amountPaise }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        }),
      ),
  };
}
