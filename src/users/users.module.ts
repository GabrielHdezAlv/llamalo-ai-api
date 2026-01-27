import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDeletionSchedulerService } from './account-deletion-scheduler.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountDeletionSchedulerService],
})
export class UsersModule {}
