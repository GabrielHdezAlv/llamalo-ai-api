import { Module } from '@nestjs/common';
import { LearningService } from './learning.service';

@Module({
  providers: [LearningService],
  exports: [LearningService],
})
export class LearningModule {}
