// A READ-ONLY probe: which Razorpay endpoints answer with data for YOUR test keys?
//
//   npm run razorpay:probe -w @ziro/api -- --confirm
//
// It reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from .env (test keys only: a live key is refused),
// makes six GET requests asking for a single record each, and prints, per endpoint, whether Razorpay
// answered and whether it had at least one record. It prints no record, no id and no amount, and it
// stores nothing. It talks to your Razorpay account, so it does nothing without --confirm.
import { istBusinessDate } from '@ziro/core/time';
import { loadDotEnv } from '../config/dotenv.js';
import { parseCollection } from '../razorpay/entries.js';
import { RazorpayApiError, RazorpayConfigError } from '../razorpay/errors.js';
import { createSdkClient } from '../razorpay/sdk-client.js';
import { isConfirmed, NOT_CONFIRMED_MESSAGE } from './probe-guard.js';

const DAY = 86_400;

async function main(): Promise<number> {
  if (!isConfirmed(process.argv)) {
    console.log(NOT_CONFIRMED_MESSAGE);
    return 2;
  }
  loadDotEnv();
  const keyId = process.env['RAZORPAY_KEY_ID'] ?? '';
  const keySecret = process.env['RAZORPAY_KEY_SECRET'] ?? '';
  if (keyId === '' || keySecret === '') {
    console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys) in .env first.');
    return 2;
  }

  let client;
  try {
    client = createSdkClient({ keyId, keySecret, retry: { maxAttempts: 3 } });
  } catch (error) {
    console.error(
      error instanceof RazorpayConfigError ? error.message : 'could not create the client',
    );
    return 2;
  }

  const now = Math.floor(Date.now() / 1000);
  const window = { from: now - 90 * DAY, to: now, count: 1, skip: 0 };
  const today = istBusinessDate(now);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];

  const probes: [string, () => Promise<unknown>][] = [
    ['GET /v1/payments            (last 90 days)', () => client.listPayments(window)],
    ['GET /v1/orders              (last 90 days)', () => client.listOrders(window)],
    ['GET /v1/refunds             (last 90 days)', () => client.listRefunds(window)],
    ['GET /v1/settlements         (last 90 days)', () => client.listSettlements(window)],
    [
      'GET /v1/settlements/recon   (this month)  ',
      () => client.settlementRecon({ year, month, day: 1, count: 1, skip: 0 }),
    ],
    [
      'GET /v1/settlements/recon   (today)       ',
      () => client.settlementRecon({ year, month, day, count: 1, skip: 0 }),
    ],
  ];

  console.log('Read-only probe of Razorpay TEST mode. No records are printed or stored.\n');
  for (const [label, run] of probes) {
    try {
      const has = parseCollection(await run(), label).length > 0;
      console.log(`${label}  answered, ${has ? 'HAS data' : 'empty'}`);
    } catch (error) {
      if (error instanceof RazorpayApiError) {
        console.log(`${label}  ERROR HTTP ${error.statusCode} ${error.code}: ${error.description}`);
      } else {
        console.log(`${label}  ERROR ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }
  console.log('\nPaste this output back: it settles which entities need the synthetic fallback.');
  return 0;
}

process.exitCode = await main();
