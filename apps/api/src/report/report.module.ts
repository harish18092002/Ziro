import { Controller, Get, Module, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { REASON_CODES } from '@ziro/core/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { DbModule } from '../db/db.module.js';
import { ReviewModule } from '../review/review.module.js';
import { DownloadService, type DownloadFile } from './downloads.js';
import { type ExceptionQuery, ReportService } from './report.service.js';

const exceptionsQuery = z.strictObject({
  filter: z.enum(['all', 'waiting', 'refused', 'unexamined', 'resolved']).default('all'),
  reason: z.enum(REASON_CODES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const recordsQuery = z.strictObject({ q: z.string().trim().min(2).max(60) });

@Controller()
export class ReportController {
  constructor(
    private readonly report: ReportService,
    private readonly downloads: DownloadService,
  ) {}

  /** Totals per source, match rate by tier, the gap, exceptions by reason, and what the run cost. */
  @Get('runs/:id/overview')
  overview(@Param('id', ParseUUIDPipe) runId: string) {
    return this.report.overview(runId);
  }

  @Get('runs/:id/exceptions')
  exceptions(
    @Param('id', ParseUUIDPipe) runId: string,
    @Query(new ZodPipe(exceptionsQuery)) query: ExceptionQuery,
  ) {
    return this.report.exceptions(runId, query);
  }

  @Get('exceptions/:id')
  exception(@Param('id', ParseUUIDPipe) id: string) {
    return this.report.exception(id);
  }

  /** Finds records by key (order reference, pay_..., setl_..., UTR, statement row) for their audit timeline. */
  @Get('runs/:id/records')
  records(
    @Param('id', ParseUUIDPipe) runId: string,
    @Query(new ZodPipe(recordsQuery)) query: { q: string },
  ) {
    return this.report.searchRecords(runId, query.q);
  }

  @Get('runs/:id/report.json')
  async json(@Param('id', ParseUUIDPipe) runId: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.downloads.reportJson(runId));
  }

  @Get('runs/:id/report.csv')
  async summaryCsv(
    @Param('id', ParseUUIDPipe) runId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send(res, await this.downloads.reportCsv(runId));
  }

  @Get('runs/:id/exceptions.csv')
  async exceptionsCsv(
    @Param('id', ParseUUIDPipe) runId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send(res, await this.downloads.exceptionsCsv(runId));
  }

  @Get('runs/:id/journal-lines.csv')
  async journalLines(
    @Param('id', ParseUUIDPipe) runId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send(res, await this.downloads.journalLinesCsv(runId));
  }

  @Get('runs/:id/journal-entries.csv')
  async journalCsv(
    @Param('id', ParseUUIDPipe) runId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send(res, await this.downloads.journalCsv(runId));
  }

  private send(res: Response, file: DownloadFile): string {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.omitted > 0) res.setHeader('X-Ziro-Rows-Omitted', String(file.omitted));
    return file.body;
  }
}

@Module({
  imports: [DbModule, ReviewModule],
  controllers: [ReportController],
  providers: [ReportService, DownloadService],
  exports: [ReportService],
})
export class ReportModule {}
