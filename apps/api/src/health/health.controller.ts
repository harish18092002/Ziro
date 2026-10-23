import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { type HealthReport, HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Whether this process is up and serving, and nothing else. It does not look at the database or Redis, so
   * an outage of either never gets the container killed (a liveness probe that did would turn a Neon wake-up
   * into a restart loop).
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Whether it can do its work: the database and Redis both answer. The startup probe and monitoring use this. */
  @Get()
  async get(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
