import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { ShopifyModule } from '../shopify/shopify.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module'; // Importar AuthModule para usar EmailService
import { UsersModule } from '../users/users.module';
import { WebhookActionsModule } from '../webhook-actions/webhook-actions.module';
import { PlanLimitsModule } from '../plan-limits/plan-limits.module';
import { OutboundService } from './outbound.service';

@Module({
  imports: [
    ShopifyModule,
    MetricsModule,
    AgentsModule,
    AuthModule,
    UsersModule,
    WebhookActionsModule,
    PlanLimitsModule,
  ],
  controllers: [CallsController],
  providers: [TwilioService, StreamsGateway, OutboundService],
  exports: [StreamsGateway, OutboundService],
})
export class CallsModule {}
