import { Controller, Post, Get, Query } from '@nestjs/common';
import { EmailService } from './email.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';

@ApiTags('test-email')
@Controller('test-email')
export class TestEmailController {
  constructor(private readonly emailService: EmailService) {}

  @Get('config')
  @ApiOperation({ summary: 'Verificar configuración del servicio de email' })
  checkConfig() {
    return {
      mailerSend: {
        hasApiKey: !!process.env.MAILERSEND_API_KEY,
        fromEmail: process.env.MAILERSEND_FROM_EMAIL || process.env.SMTP_USER || 'team@llamalo.ai',
        fromName: process.env.MAILERSEND_FROM_NAME || 'Llamalo AI',
      },
      smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || '587',
        user: process.env.SMTP_USER || 'team@llamalo.ai',
        hasPass: !!process.env.SMTP_PASS,
      },
      frontendUrl: process.env.FRONTEND_URL || 'https://app.llamalo.ai',
      activeService: process.env.MAILERSEND_API_KEY ? 'MailerSend' : (process.env.SMTP_PASS ? 'SMTP' : 'None')
    };
  }

  @Post('verify-connection')
  @ApiOperation({ summary: 'Verificar conexión de email' })
  async verifyConnection() {
    try {
      const result = await this.emailService.verifyConnection();
      return {
        success: result,
        message: result ? 'Conexión de email (MailerSend/SMTP) exitosa' : 'Error en conexión de email',
      };
    } catch (error) {
      return {
        success: false,
        message: `Error: ${(error as Error).message}`,
        details: error,
      };
    }
  }

  @Post('send-test')
  @ApiOperation({ summary: 'Enviar email de prueba' })
  @ApiQuery({ name: 'email', required: false, description: 'Email de destino para la prueba' })
  async sendTestEmail(@Query('email') emailToTest?: string) {
    try {
      const testEmail = emailToTest || 'team@llamalo.ai'; // Cambiar por query param o fallback
      const testToken = 'test-token-123';

      const result = await this.emailService.sendVerificationEmail(
        testEmail,
        testToken,
      );
      return {
        success: true,
        message: `Email de prueba enviado a ${testEmail}`,
        result,
      };
    } catch (error) {
      return {
        success: false,
        message: `Error al enviar email a ${emailToTest || 'team@llamalo.ai'}: ${(error as Error).message}`,
        details: error,
      };
    }
  }
}
