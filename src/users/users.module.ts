import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDeletionSchedulerService } from './account-deletion-scheduler.service';
import { MailerLiteModule } from '../mailerlite/mailerlite.module';
import { ProfileEventsModule } from '../profile-events/profile-events.module';

@Module({
  imports: [MailerLiteModule, ProfileEventsModule],
  controllers: [UsersController],
  providers: [UsersService, AccountDeletionSchedulerService],
  exports: [UsersService],
})
export class UsersModule {}
