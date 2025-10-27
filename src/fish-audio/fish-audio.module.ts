import { Module } from '@nestjs/common';
import { FishAudioController } from './fish-audio.controller';
import { FishAudioService } from './fish-audio.service';
import { FishTtsHttpService } from './http/fish-tts-http.service';
import { FishAsrHttpService } from './http/fish-asr-http.service';

@Module({
  controllers: [FishAudioController],
  providers: [FishAudioService, FishTtsHttpService, FishAsrHttpService],
  exports: [FishTtsHttpService, FishAsrHttpService],
})
export class FishAudioModule {}
