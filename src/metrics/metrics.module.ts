import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MailerLiteModule } from '../mailerlite/mailerlite.module';
import { ProfileEventsModule } from '../profile-events/profile-events.module';
import { OwnerRoleGuard } from '../auth/owner-role.guard';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [MailerLiteModule, ProfileEventsModule, StripeModule],
  controllers: [MetricsController],
  providers: [MetricsService, OwnerRoleGuard],
  exports: [MetricsService],
})
export class MetricsModule {}
