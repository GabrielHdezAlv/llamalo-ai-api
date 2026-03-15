import { Module } from '@nestjs/common';
import { MailerLiteService } from './mailerlite.service';
import { MailerLiteScheduler } from './mailerlite.scheduler';

@Module({
  providers: [MailerLiteService, MailerLiteScheduler],
  exports: [MailerLiteService],
})
export class MailerLiteModule {}
