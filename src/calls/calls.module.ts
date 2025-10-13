import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [LlmModule],
  controllers: [CallsController],
  providers: [TwilioService, StreamsGateway, FishTtsService, FishAsrService],
})
export class CallsModule {}
