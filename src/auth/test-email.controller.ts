import { Controller, Post, Get } from '@nestjs/common';
import { EmailService } from './email.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('test-email')
@Controller('test-email')
export class TestEmailController {
  constructor(private readonly emailService: EmailService) {}

  @Get('config')
  @ApiOperation({ summary: 'Verificar configuración del servicio de email' })
  checkConfig() {
    return {
      smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: process.env.SMTP_PORT || '587',
      smtpUser: process.env.SMTP_USER || 'team@llamalo.ai',
      hasSmtpPass: !!process.env.SMTP_PASS,
      frontendUrl: process.env.FRONTEND_URL || 'https://app.llamalo.ai',
    };
  }

  @Post('verify-connection')
  @ApiOperation({ summary: 'Verificar conexión SMTP' })
  async verifyConnection() {
    try {
      const result = await this.emailService.verifyConnection();
      return {
        success: result,
        message: result ? 'Conexión SMTP exitosa' : 'Error en conexión SMTP',
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
  async sendTestEmail() {
    try {
      const testEmail = 'test@example.com'; // Cambiar por email real para pruebas
      const testToken = 'test-token-123';

      const result = await this.emailService.sendVerificationEmail(
        testEmail,
        testToken,
      );
      return {
        success: true,
        message: 'Email de prueba enviado',
        result,
      };
    } catch (error) {
      return {
        success: false,
        message: `Error al enviar email: ${(error as Error).message}`,
        details: error,
      };
    }
  }
}
