import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';

@Module({
  imports: [],
  controllers: [CallsController],
  providers: [TwilioService, StreamsGateway],
  exports: [StreamsGateway],
})
export class CallsModule {}
