import { Module } from '@nestjs/common';
import { DiscordSubscriberNotifyService } from './discord-subscriber-notify.service';

@Module({
  providers: [DiscordSubscriberNotifyService],
  exports: [DiscordSubscriberNotifyService],
})
export class DiscordModule {}
