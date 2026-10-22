import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { PROPOSAL_PIPELINE } from './pipeline.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

@Module({
  imports: [DbModule],
  controllers: [ReviewController],
  providers: [ReviewService, { provide: PROPOSAL_PIPELINE, useExisting: ReviewService }],
  exports: [ReviewService, PROPOSAL_PIPELINE],
})
export class ReviewModule {}
