import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MailerLiteModule } from '../mailerlite/mailerlite.module';
import { ProfileEventsModule } from '../profile-events/profile-events.module';

@Module({
  imports: [MailerLiteModule, ProfileEventsModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
