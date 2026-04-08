import { Module } from '@nestjs/common';
import { ProfileEventsService } from './profile-events.service';

@Module({
  providers: [ProfileEventsService],
  exports: [ProfileEventsService],
})
export class ProfileEventsModule {}
