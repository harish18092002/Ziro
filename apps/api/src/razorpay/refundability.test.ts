import { describe, expect, it } from 'vitest';
import { MIN_REFUND_PAISE, refundState } from './refundability.js';

const payment = (over: Partial<Parameters<typeof refundState>[0]> = {}) => ({
  status: 'captured',
  captured: true,
  amount: 50_000n,
  amountRefunded: 0n,
  ...over,
});

describe('refundState', () => {
  it('lets a captured payment be refunded for all of it', () => {
    expect(refundState(payment())).toEqual({ refundable: 50_000n, allowed: true, why: null });
  });

  it('offers only what is left of a partly refunded payment', () => {
    expect(refundState(payment({ amountRefunded: 12_345n }))).toEqual({
      refundable: 37_655n,
      allowed: true,
      why: null,
    });
  });

  it('allows exactly the smallest refund, Re 1, and not a paisa less', () => {
    expect(refundState(payment({ amountRefunded: 50_000n - MIN_REFUND_PAISE })).allowed).toBe(true);
    const short = refundState(payment({ amountRefunded: 50_000n - MIN_REFUND_PAISE + 1n }));
    expect(short.allowed).toBe(false);
    expect(short.refundable).toBe(99n);
    expect(short.why).toContain('₹0.99');
  });

  it.each([
    ['authorized', false, 'Not captured yet'],
    ['captured', false, 'Not captured yet'],
    ['created', false, 'Not paid yet'],
    ['failed', false, 'failed'],
    ['refunded', true, 'Already fully refunded'],
  ])('refuses a %s payment (captured=%s) with a reason', (status, captured, why) => {
    const state = refundState(
      payment({ status, captured, amountRefunded: status === 'refunded' ? 50_000n : 0n }),
    );
    expect(state.allowed).toBe(false);
    expect(state.why).toContain(why);
  });

  it('treats a payment whose refunds add up to all of it as fully refunded, whatever its status says', () => {
    const state = refundState(payment({ amountRefunded: 50_000n }));
    expect(state).toMatchObject({
      allowed: false,
      refundable: 0n,
      why: 'Already fully refunded.',
    });
  });

  it('never reports a negative amount left', () => {
    expect(refundState(payment({ amountRefunded: 60_000n })).refundable).toBe(0n);
  });
});
