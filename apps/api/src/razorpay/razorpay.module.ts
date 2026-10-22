import { Inject, Injectable, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { resolveDataDir } from './data-dir.js';
import { RazorpayConfigError } from './errors.js';
import { createSdkClient } from './sdk-client.js';
import type { RazorpaySource } from './source.js';
import { SyntheticSource } from './synthetic.source.js';
import { TestModeSource } from './testmode.source.js';

/** Builds the Razorpay source a run should use, from configuration. */
@Injectable()
export class RazorpaySourceFactory {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * `RAZORPAY_SOURCE=synthetic` reads the generated dataset. `testmode` talks to Razorpay with the
   * test keys and falls back to that same dataset for whatever test mode cannot supply.
   */
  forRun(runId: string): RazorpaySource {
    const synthetic = new SyntheticSource({
      runId,
      dir: resolveDataDir(this.env.SYNTHETIC_DATA_DIR),
    });
    if (this.env.RAZORPAY_SOURCE === 'synthetic') return synthetic;

    const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = this.env;
    if (!keyId || !keySecret) {
      throw new RazorpayConfigError(
        'RAZORPAY_SOURCE=testmode needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
      );
    }
    return new TestModeSource({
      runId,
      client: createSdkClient({ keyId, keySecret }),
      fallback: synthetic,
    });
  }
}

@Module({ providers: [RazorpaySourceFactory], exports: [RazorpaySourceFactory] })
export class RazorpayModule {}
