import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { ShopifyModule } from '../shopify/shopify.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [ShopifyModule, MetricsModule],
  controllers: [CallsController],
  providers: [TwilioService, StreamsGateway],
  exports: [StreamsGateway],
})
export class CallsModule {}
