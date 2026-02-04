import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { TestEmailController } from './test-email.controller';

@Module({
  controllers: [AuthController, TestEmailController],
  providers: [AuthService, EmailService],
})
export class AuthModule {}
