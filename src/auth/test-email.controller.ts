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
    const hasResend = !!process.env.RESEND_API_KEY;
    const hasSmtp = !!process.env.SMTP_PASS;
    return {
      resend: {
        hasApiKey: hasResend,
        fromEmail:
          process.env.RESEND_FROM_EMAIL ||
          process.env.SMTP_USER ||
          'team@llamalo.ai',
        fromName: process.env.RESEND_FROM_NAME || 'Llamalo AI',
      },
      smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || '587',
        user: process.env.SMTP_USER || 'team@llamalo.ai',
        hasPass: hasSmtp,
      },
      frontendUrl: process.env.FRONTEND_URL || 'https://app.llamalo.ai',
      activeService: hasResend ? 'Resend' : hasSmtp ? 'SMTP' : 'None',
    };
  }

  @Post('verify-connection')
  @ApiOperation({ summary: 'Verificar conexión de email' })
  async verifyConnection() {
    try {
      const result = await this.emailService.verifyConnection();
      return {
        success: result,
        message: result
          ? 'Conexión de email (Resend/SMTP) correcta'
          : 'Error en conexión de email',
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
  @ApiQuery({
    name: 'email',
    required: false,
    description: 'Email de destino para la prueba',
  })
  async sendTestEmail(@Query('email') emailToTest?: string) {
    try {
      const testEmail = emailToTest || 'team@llamalo.ai';
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
