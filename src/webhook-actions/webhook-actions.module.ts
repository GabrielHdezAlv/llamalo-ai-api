import { Module } from '@nestjs/common';
import { PlanLimitsModule } from '../plan-limits/plan-limits.module';
import { WebhookActionsController } from './webhook-actions.controller';
import { WebhookActionsService } from './webhook-actions.service';

@Module({
  imports: [PlanLimitsModule],
  controllers: [WebhookActionsController],
  providers: [WebhookActionsService],
  exports: [WebhookActionsService],
})
export class WebhookActionsModule {}
