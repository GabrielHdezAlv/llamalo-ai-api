import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { StreamsController } from '../streams/streams.controller';

@Module({
  imports: [],
  controllers: [CallsController, StreamsController],
  providers: [TwilioService, StreamsGateway],
  exports: [StreamsGateway],
})
export class CallsModule {}
