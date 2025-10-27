import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { TwilioService } from './twilio.service';
import { StreamsGateway } from '../streams/streams.gateway';
import { StreamsController } from '../streams/streams.controller';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { LlmModule } from '../llm/llm.module';
import { TwilioCallMediaService } from 'src/twilio/twilio-call-media.service';
import { FishAudioModule } from 'src/fish-audio/fish-audio.module';

@Module({
  imports: [LlmModule, FishAudioModule],
  controllers: [CallsController, StreamsController],
  providers: [
    TwilioService,
    StreamsGateway,
    FishTtsService,
    FishAsrService,
    TwilioCallMediaService,
  ],
  exports: [StreamsGateway],
})
export class CallsModule {}
