import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentKnowledgeService } from './agent-knowledge.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  imports: [KnowledgeBaseModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentKnowledgeService],
  exports: [AgentKnowledgeService],
})
export class AgentsModule {}
