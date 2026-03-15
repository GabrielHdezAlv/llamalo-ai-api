import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { TestEmailController } from './test-email.controller';
import { MailerLiteModule } from '../mailerlite/mailerlite.module';

@Module({
  imports: [MailerLiteModule],
  controllers: [AuthController, TestEmailController],
  providers: [AuthService, EmailService],
  exports: [EmailService, AuthService], // Exportar EmailService para que Xenon lo use
})
export class AuthModule {}
