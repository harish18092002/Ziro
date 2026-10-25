import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError, RazorpayConfigError } from './errors.js';
import { TEST_KEY_ID, TEST_KEY_SECRET } from './razorpay.fixtures.js';
import { createSdkWriter } from './sdk-client.js';

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly body: unknown;
}

/** A network that answers from a script and remembers what was sent. */
function network(answers: { status: number; body: unknown }[]) {
  const seen: Seen[] = [];
  const adapter: AxiosAdapter = (config) => {
    seen.push({
      method: config.method,
      url: config.url,
      body: typeof config.data === 'string' ? (JSON.parse(config.data) as unknown) : undefined,
    });
    const answer = answers.shift() ?? { status: 200, body: {} };
    const response = {
      data: answer.body,
      status: answer.status,
      statusText: '',
      headers: {},
      config,
      request: {},
    } as AxiosResponse;
    return answer.status >= 400
      ? Promise.reject(
          new AxiosError(
            'failed',
            answer.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
            config,
            {},
            response,
          ),
        )
      : Promise.resolve(response);
  };
  const writer = createSdkWriter({
    keyId: TEST_KEY_ID,
    keySecret: TEST_KEY_SECRET,
    adapter,
    deps: { sleep: () => Promise.resolve(), random: () => 0.5 },
  });
  return { writer, seen };
}

describe('the test-account writer', () => {
  it('reads one payment with a GET, and does not write anything', async () => {
    const { writer, seen } = network([{ status: 200, body: { id: 'pay_AbCdEf1234567' } }]);
    await writer.fetchPayment('pay_AbCdEf1234567');
    expect(seen).toEqual([
      { method: 'get', url: '/v1/payments/pay_AbCdEf1234567', body: undefined },
    ]);
  });

  it('posts a refund to the payment, with the amount in paise and the notes as given', async () => {
    const { writer, seen } = network([{ status: 200, body: { id: 'rfnd_x' } }]);
    await writer.refundPayment('pay_AbCdEf1234567', { amountPaise: 500, notes: { a: 'b' } });
    expect(seen).toEqual([
      {
        method: 'post',
        url: '/v1/payments/pay_AbCdEf1234567/refund',
        body: { amount: 500, notes: { a: 'b' } },
      },
    ]);
  });

  it('leaves the amount out for a full refund, so Razorpay refunds the whole payment', async () => {
    const { writer, seen } = network([{ status: 200, body: { id: 'rfnd_x' } }]);
    await writer.refundPayment('pay_AbCdEf1234567', {});
    expect(seen[0]?.body).toEqual({});
  });

  it('carries the reasonless refusal through intact, after exactly one request', async () => {
    const { writer, seen } = network([
      {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'invalid request sent' } },
      },
    ]);
    const error = await writer.refundPayment('pay_AbCdEf1234567', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayApiError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'invalid request sent',
      attempts: 1,
    });
    expect(seen).toHaveLength(1);
  });

  it('never repeats a refund after a server fault: a second POST could refund twice', async () => {
    const { writer, seen } = network([
      { status: 500, body: { error: { code: 'SERVER_ERROR', description: 'oops' } } },
      { status: 200, body: { id: 'rfnd_x' } },
    ]);
    await expect(writer.refundPayment('pay_AbCdEf1234567', {})).rejects.toBeInstanceOf(
      RazorpayApiError,
    );
    expect(seen).toHaveLength(1);
  });

  it('refuses a live key before any request', () => {
    expect(() => createSdkWriter({ keyId: 'rzp_live_ZZZZZZZZ1234', keySecret: 's' })).toThrow(
      RazorpayConfigError,
    );
  });
});
