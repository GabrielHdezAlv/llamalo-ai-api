import { Module } from '@nestjs/common';
import { DeepgramAsrHttpService } from './deepgram-asr-http.service';

@Module({
  providers: [DeepgramAsrHttpService],
  exports: [DeepgramAsrHttpService],
})
export class DeepgramModule {}

