import { Module } from '@nestjs/common';
import { FishAudioController } from './fish-audio.controller';
import { FishAudioService } from './fish-audio.service';
import { FishTtsHttpService } from './http/fish-tts-http.service';

@Module({
  controllers: [FishAudioController],
  providers: [FishAudioService, FishTtsHttpService],
  exports: [FishTtsHttpService],
})
export class FishAudioModule {}
