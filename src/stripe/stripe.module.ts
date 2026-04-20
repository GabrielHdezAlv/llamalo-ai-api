import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { AuthModule } from '../auth/auth.module';
import { TwilioModule } from '../twilio/twilio.module';
import { DiscordModule } from '../discord/discord.module';

@Module({
  imports: [AuthModule, TwilioModule, DiscordModule],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
