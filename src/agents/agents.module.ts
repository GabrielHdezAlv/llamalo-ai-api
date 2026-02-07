import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  imports: [KnowledgeBaseModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
