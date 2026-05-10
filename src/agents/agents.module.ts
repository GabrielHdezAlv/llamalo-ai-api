import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { OutboundIngressController } from './outbound-ingress.controller';
import { AgentsService } from './agents.service';
import { AgentKnowledgeService } from './agent-knowledge.service';
import { OutboundQueueService } from './outbound-queue.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';
import { WebhookActionsModule } from '../webhook-actions/webhook-actions.module';

@Module({
  imports: [KnowledgeBaseModule, WebhookActionsModule],
  controllers: [AgentsController, OutboundIngressController],
  providers: [AgentsService, AgentKnowledgeService, OutboundQueueService],
  exports: [AgentKnowledgeService, OutboundQueueService],
})
export class AgentsModule {}
