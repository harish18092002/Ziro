import { Controller, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ReconService } from './recon.service.js';

@Controller('runs')
export class ReconController {
  constructor(private readonly recon: ReconService) {}

  /** Runs the rule matcher over an imported run and keeps its groups and exceptions. Safe to repeat. */
  @Post(':id/match')
  @HttpCode(200)
  match(@Param('id', ParseUUIDPipe) runId: string) {
    return this.recon.match(runId);
  }
}

@Module({
  imports: [DbModule],
  controllers: [ReconController],
  providers: [ReconService],
  exports: [ReconService],
})
export class ReconModule {}
