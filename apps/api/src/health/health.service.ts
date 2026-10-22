import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB_PROBE, type Probe, REDIS_PROBE, withTimeout } from './probe.js';

export const PROBE_TIMEOUT_MS = 2000;

export type CheckState = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  checks: { db: CheckState; redis: CheckState };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DB_PROBE) private readonly dbProbe: Probe,
    @Inject(REDIS_PROBE) private readonly redisProbe: Probe,
  ) {}

  async check(): Promise<HealthReport> {
    const [db, redis] = await Promise.all([
      this.run('db', this.dbProbe),
      this.run('redis', this.redisProbe),
    ]);
    return { status: db === 'up' && redis === 'up' ? 'ok' : 'error', checks: { db, redis } };
  }

  /** Failure detail goes to the log only; the HTTP response never carries error messages. */
  private async run(name: string, probe: Probe): Promise<CheckState> {
    try {
      await withTimeout(probe(), PROBE_TIMEOUT_MS);
      return 'up';
    } catch (err) {
      this.logger.warn(`${name} probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'down';
    }
  }
}
