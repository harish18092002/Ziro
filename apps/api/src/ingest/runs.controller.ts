import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  type DemoResult,
  IngestService,
  type RazorpayImportReport,
  type RunSummary,
  type RunView,
} from './ingest.service.js';
import type { CsvImportReport } from './report.js';
import {
  type CreateRunInput,
  createRunSchema,
  type RazorpayImportInput,
  razorpayImportSchema,
} from './requests.js';

/** The multipart field a CSV is uploaded in: `curl -F file=@ledger.csv`. */
const FILE_FIELD = 'file';

/** A file nobody could read is a 422 with the full report as the body: the UI has one shape to show. */
function orRefuse(report: CsvImportReport): CsvImportReport {
  if (report.status === 'rejected') throw new UnprocessableEntityException(report);
  return report;
}

@Controller('runs')
export class RunsController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  create(@Body(new ZodPipe(createRunSchema)) body: CreateRunInput): Promise<RunView> {
    return this.ingest.createRun(body);
  }

  /** One click: a new run holding the demo dataset. Declared before the `:id` routes on purpose. */
  @Post('demo')
  demo(): Promise<DemoResult> {
    return this.ingest.createDemo();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<RunSummary> {
    return this.ingest.getRun(id);
  }

  @Post(':id/import/ledger')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor(FILE_FIELD))
  async importLedger(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<CsvImportReport> {
    return orRefuse(await this.ingest.importCsv(id, 'ledger', upload(file)));
  }

  @Post(':id/import/bank')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor(FILE_FIELD))
  async importBank(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<CsvImportReport> {
    return orRefuse(await this.ingest.importCsv(id, 'bank', upload(file)));
  }

  @Post(':id/import/razorpay')
  @HttpCode(200)
  importRazorpay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(razorpayImportSchema)) body: RazorpayImportInput,
  ): Promise<RazorpayImportReport> {
    return this.ingest.importRazorpay(id, body);
  }
}

function upload(file: Express.Multer.File | undefined): { buffer: Buffer; originalName: string } {
  if (!file) {
    throw new BadRequestException(
      `send the CSV as multipart/form-data in a field named "${FILE_FIELD}"`,
    );
  }
  return { buffer: file.buffer, originalName: file.originalname };
}
