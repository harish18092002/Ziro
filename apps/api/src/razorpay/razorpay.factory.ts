import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { resolveDataDir } from './data-dir.js';
import { RazorpayConfigError } from './errors.js';
import { createSdkClient, createSdkWriter, type RazorpayWriter } from './sdk-client.js';
import type { RazorpaySource } from './source.js';
import { SyntheticSource } from './synthetic.source.js';
import { TestModeSource } from './testmode.source.js';

/** The run id behind a listing that is shown and thrown away. Not a run: nothing is written under it. */
const LISTING_RUN_ID = '00000000-0000-4000-8000-000000000000';

/** Builds the Razorpay source a run should use, from configuration. */
@Injectable()
export class RazorpaySourceFactory {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** The generated dataset, whatever `RAZORPAY_SOURCE` says: the demo preset never touches Razorpay. */
  synthetic(runId: string, dir?: string): SyntheticSource {
    return new SyntheticSource({ runId, dir: dir ?? resolveDataDir(this.env.SYNTHETIC_DATA_DIR) });
  }

  /**
   * `RAZORPAY_SOURCE=synthetic` reads the generated dataset. `testmode` talks to Razorpay with the test
   * keys and returns what your test account holds, nothing more: an empty account is an empty answer.
   */
  forRun(runId: string): RazorpaySource {
    if (this.env.RAZORPAY_SOURCE === 'synthetic') return this.synthetic(runId);
    const { keyId, keySecret } = this.testKeys();
    return new TestModeSource({ runId, client: createSdkClient({ keyId, keySecret }) });
  }

  /**
   * A read-only view of the test account for the console's live payments list. It is not part of any run:
   * the ids it makes belong to no run and are never stored.
   */
  account(): RazorpaySource {
    const { keyId, keySecret } = this.testKeys();
    return new TestModeSource({
      runId: LISTING_RUN_ID,
      client: createSdkClient({ keyId, keySecret }),
    });
  }

  /** The writer for the test-payments helper. Only exists in test mode. */
  writer(): RazorpayWriter {
    const { keyId, keySecret } = this.testKeys();
    return createSdkWriter({ keyId, keySecret });
  }

  /** What the console needs to know: which source is on, and whether test mode can be used. */
  status(): { source: Env['RAZORPAY_SOURCE']; ready: boolean; keyId: string | null } {
    const ready =
      this.env.RAZORPAY_SOURCE === 'testmode' &&
      Boolean(this.env.RAZORPAY_KEY_ID) &&
      Boolean(this.env.RAZORPAY_KEY_SECRET);
    // The key id is the public half (Checkout needs it in the page); the secret never leaves the server.
    return {
      source: this.env.RAZORPAY_SOURCE,
      ready,
      keyId: ready ? (this.env.RAZORPAY_KEY_ID ?? null) : null,
    };
  }

  private testKeys(): { keyId: string; keySecret: string } {
    if (this.env.RAZORPAY_SOURCE !== 'testmode') {
      throw new RazorpayConfigError('Razorpay test mode is off: set RAZORPAY_SOURCE=testmode');
    }
    const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = this.env;
    if (!keyId || !keySecret) {
      throw new RazorpayConfigError(
        'RAZORPAY_SOURCE=testmode needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
      );
    }
    return { keyId, keySecret };
  }
}
