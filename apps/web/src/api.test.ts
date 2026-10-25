import { describe, expect, it } from 'vitest';
import { ApiError, reasonOf } from './api';

describe('reasonOf', () => {
  it("gives a rejected file's own reasons first", () => {
    const error = new ApiError(422, 'the file was refused', null, {
      fatal: ['missing required column: amount', 'not UTF-8'],
    });
    expect(reasonOf(error)).toBe('missing required column: amount; not UTF-8');
  });

  it("falls back to the server's message when there are no file reasons", () => {
    expect(reasonOf(new ApiError(409, 'Not captured yet', null, { fatal: [] }))).toBe(
      'Not captured yet',
    );
    expect(reasonOf(new ApiError(502, 'Razorpay said: "x"', null, 'plain text'))).toBe(
      'Razorpay said: "x"',
    );
  });

  it('copes with errors that are not the API’s', () => {
    expect(reasonOf(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(reasonOf('boom')).toBe('boom');
  });
});
