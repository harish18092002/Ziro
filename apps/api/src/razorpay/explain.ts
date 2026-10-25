import type { RazorpayApiError } from './errors.js';

export type Action = 'refund' | 'other';

/**
 * Razorpay refuses some test-mode refunds with a bare `BAD_REQUEST_ERROR: invalid request sent` and no reason,
 * field or step. Its refund documentation lists about twenty failures, each with a message, and this is not one of
 * them (a low balance has its own message there). Developers report it on the SDK's issue tracker
 * (razorpay-node #438, #454); some link it to the test balance, and nobody has confirmed the cause. So this says
 * what is known and what is not, and what to try, without claiming a cause.
 */
export const REFUND_NO_REASON =
  'Razorpay refused this refund and gave no reason ("invalid request sent"). Razorpay does not document that ' +
  'message. Other developers report it on test-mode refunds and some link it to the test balance, but the ' +
  'cause is unconfirmed. Try a smaller amount, such as ₹1.';

/**
 * A Razorpay failure as a sentence for a person: what Razorpay said, and what to do about it where that is
 * known. Built from Razorpay's own error fields only, so it carries no credentials.
 */
export function explainRazorpayFailure(error: RazorpayApiError, action: Action = 'other'): string {
  const description = error.description.trim();
  const facts = `(HTTP ${error.statusCode}, ${error.code})`;

  if (error.statusCode === 0) {
    return `Could not reach Razorpay: ${description || 'no answer'}. Check your connection and try again.`;
  }
  if (/api (key|secret).*invalid/i.test(description)) {
    return `Razorpay rejected your test keys ${facts}. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env, then restart the server.`;
  }
  if (error.statusCode === 429) {
    return `Razorpay is limiting requests ${facts}. Wait a minute and try again.`;
  }
  if (error.statusCode >= 500) {
    return `Razorpay had a problem on its side ${facts}. Try again in a moment.`;
  }
  if (action === 'refund' && /invalid request sent/i.test(description)) {
    return `${REFUND_NO_REASON} ${facts}`;
  }
  if (description === '') return `Razorpay answered without a reason ${facts}.`;
  return `Razorpay said: "${description.replace(/\.$/, '')}" ${facts}.`;
}
