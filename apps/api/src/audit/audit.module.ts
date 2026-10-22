import { Controller, Get, Module, Param, ParseUUIDPipe } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { TimelineService } from './timeline.service.js';

@Controller('records')
export class RecordsController {
  constructor(private readonly timeline: TimelineService) {}

  /** The full timeline of any source record: its import, then every step that named it. */
  @Get(':id/audit')
  audit(@Param('id', ParseUUIDPipe) recordId: string) {
    return this.timeline.timeline(recordId);
  }
}

@Module({
  imports: [DbModule],
  controllers: [RecordsController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class AuditModule {}
