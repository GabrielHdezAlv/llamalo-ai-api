import { Module } from '@nestjs/common';
import { FishAudioController } from './fish-audio.controller';
import { FishAudioService } from './fish-audio.service';

@Module({
  controllers: [FishAudioController],
  providers: [FishAudioService],
})
export class FishAudioModule {}
