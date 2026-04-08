import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { ShopifyModule } from '../shopify/shopify.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module'; // Importar AuthModule para usar EmailService
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ShopifyModule, MetricsModule, AgentsModule, AuthModule, UsersModule],
  controllers: [CallsController],
  providers: [TwilioService, StreamsGateway],
  exports: [StreamsGateway],
})
export class CallsModule {}
