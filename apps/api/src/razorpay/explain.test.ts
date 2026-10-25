import { describe, expect, it } from 'vitest';
import { RazorpayApiError } from './errors.js';
import { explainRazorpayFailure, REFUND_NO_REASON } from './explain.js';

const err = (status: number, code: string, description: string) =>
  new RazorpayApiError(status, code, description);

describe('explainRazorpayFailure', () => {
  it('explains the reasonless refund refusal, but only for a refund', () => {
    const e = err(400, 'BAD_REQUEST_ERROR', 'invalid request sent');
    expect(explainRazorpayFailure(e, 'refund')).toBe(
      `${REFUND_NO_REASON} (HTTP 400, BAD_REQUEST_ERROR)`,
    );
    expect(explainRazorpayFailure(e, 'other')).toBe(
      'Razorpay said: "invalid request sent" (HTTP 400, BAD_REQUEST_ERROR).',
    );
  });

  it('is honest that the refund explanation is a report from other developers, not Razorpay documentation', () => {
    expect(REFUND_NO_REASON).toContain('Other developers report');
    expect(REFUND_NO_REASON).toContain('does not document');
  });

  it('quotes what Razorpay said, with the status and code', () => {
    expect(
      explainRazorpayFailure(
        err(400, 'BAD_REQUEST_ERROR', 'The payment has been fully refunded already.'),
      ),
    ).toBe(
      'Razorpay said: "The payment has been fully refunded already" (HTTP 400, BAD_REQUEST_ERROR).',
    );
  });

  it('tells a person to check the keys when Razorpay rejects them', () => {
    const text = explainRazorpayFailure(
      err(401, 'BAD_REQUEST_ERROR', 'The api key provided is invalid'),
    );
    expect(text).toContain('RAZORPAY_KEY_ID');
    expect(text).toContain('restart');
  });

  it('says what to do when there is no answer, a rate limit or a server fault', () => {
    expect(explainRazorpayFailure(err(0, 'ECONNRESET', 'socket hang up'))).toContain(
      'Check your connection',
    );
    expect(explainRazorpayFailure(err(429, 'X', 'slow down'))).toContain('Wait a minute');
    expect(explainRazorpayFailure(err(503, 'X', 'down'))).toContain('on its side');
  });

  it('copes with an answer that has no reason', () => {
    expect(explainRazorpayFailure(err(400, 'BAD_REQUEST_ERROR', ''))).toBe(
      'Razorpay answered without a reason (HTTP 400, BAD_REQUEST_ERROR).',
    );
  });
});
