import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    // Validar que las credenciales SMTP estén configuradas
    if (!process.env.SMTP_PASS) {
      this.logger.error(
        '❌ SMTP_PASS no está configurada - el servicio de email no funcionará',
      );
      throw new Error(
        'SMTP_PASS no está configurada en las variables de entorno',
      );
    }

    // Configuración del transporter para team@llamalo.ai
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER || 'team@llamalo.ai',
        pass: process.env.SMTP_PASS, // Contraseña de aplicación o app password
      },
    });

    // Verificar configuración al iniciar
    this.logger.log(
      `Email service configurado con host: ${process.env.SMTP_HOST || 'smtp.gmail.com'}, user: ${process.env.SMTP_USER || 'team@llamalo.ai'}`,
    );
    this.logger.log(`SMTP_PASS está configurada: ${!!process.env.SMTP_PASS}`);
    this.logger.log(
      `Longitud de SMTP_PASS: ${process.env.SMTP_PASS?.length || 0}`,
    );

    // Si no hay contraseña de SMTP, advertir
    if (!process.env.SMTP_PASS) {
      this.logger.warn(
        '⚠️ SMTP_PASS no está configurado - los emails no se enviarán',
      );
    }
  }

  /**
   * Enviar email de verificación de cuenta
   */
  async sendVerificationEmail(email: string, verificationToken: string) {
    this.logger.log(`📧 Intentando enviar email de verificación a: ${email}`);

    const verificationUrl = `${process.env.FRONTEND_URL || 'https://app.llamalo.ai'}/verify-email?token=${verificationToken}`;

    const mailOptions = {
      from: `"Llamalo AI" <${process.env.SMTP_USER || 'team@llamalo.ai'}>`,
      to: email,
      subject: 'Verifica tu cuenta de correo electrónico',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #333;">Bienvenido a Llamalo AI</h1>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #333; margin-top: 0;">Verifica tu correo electrónico</h2>
            <p style="color: #666; line-height: 1.6;">
              Gracias por registrarte en Llamalo AI. Para activar tu cuenta, por favor haz clic en el siguiente botón:
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" 
               style="background-color: #007bff; color: white; padding: 12px 30px; 
                      text-decoration: none; border-radius: 6px; display: inline-block; 
                      font-weight: bold; font-size: 16px;">
              Verificar mi correo electrónico
            </a>
          </div>
          
          <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;">
              <strong>Importante:</strong> Este enlace expirará en 24 horas. Si no verificas tu correo en este tiempo, 
              deberás solicitar un nuevo email de verificación.
            </p>
          </div>
          
          <div style="border-top: 1px solid #eee; padding-top: 20px; margin-top: 30px;">
            <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">
              Si no te registraste en Llamalo AI, por favor ignora este email.
            </p>
            <p style="color: #999; font-size: 12px; text-align: center; margin: 10px 0 0 0;">
              © 2026 Llamalo AI. Todos los derechos reservados.
            </p>
          </div>
        </div>
      `,
    };

    try {
      // Verificar conexión SMTP antes de enviar
      this.logger.log('🔍 Verificando conexión SMTP...');
      await this.transporter.verify();
      this.logger.log('✅ Conexión SMTP verificada');

      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `✅ Email de verificación enviado a ${email}: ${info.messageId}`,
      );
      return { success: true, messageId: info.messageId };
    } catch (error) {
      this.logger.error(
        `❌ Error al enviar email de verificación a ${email}:`,
        error,
      );

      // Detalles del error para diagnóstico
      if (error instanceof Error) {
        this.logger.error(`Error details: ${error.message}`);
        if ('code' in error) {
          this.logger.error(`Error code: ${(error as any).code}`);
        }
      }

      throw new Error(
        `No se pudo enviar el email de verificación: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Enviar email de reenvío de verificación
   */
  async resendVerificationEmail(email: string, verificationToken: string) {
    return this.sendVerificationEmail(email, verificationToken);
  }

  /**
   * Verificar conexión con el servidor SMTP
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.logger.log('Conexión SMTP verificada exitosamente');
      return true;
    } catch (error) {
      this.logger.error('Error al verificar conexión SMTP:', error);
      return false;
    }
  }

  /**
   * Enviar ticket de soporte generado por Xenon
   */
  async sendSupportTicket(
    userId: string,
    userPhone: string | undefined,
    summary: string,
    userEmail: string | undefined,
  ): Promise<{ success: boolean; messageId?: string }> {
    const email = process.env.SUPPORT_EMAIL || 'team@llamalo.ai';

    this.logger.log(`📧 Xenon enviando ticket de soporte a: ${email}`);

    const mailOptions = {
      from: `"Llamalo AI - Soporte IA" <${process.env.SMTP_USER || 'team@llamalo.ai'}>`,
      to: email,
      subject: `🚨 [ESCALADO] Soporte requerido por usuario ${userId}`,
      text: `
Un usuario ha solicitado asistencia humana a través del agente Xenon.

DETALLES DEL CLIENTE:
- ID de Usuario: ${userId}
- Teléfono de contacto: ${userPhone}

RESUMEN DEL PROBLEMA SEGÚN LA IA:
${summary}

---
Este es un correo automático generado por Xenon.
      `,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">🚨 Nuevo ticket de soporte escalado por Xenon</h2>
          <p>Un usuario ha solicitado asistencia humana durante su llamada/chat con el agente IA.</p>
          
          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #1f2937;">Detalles del Cliente:</h3>
            <ul style="color: #4b5563;">
              <li><strong>ID de Usuario:</strong> ${userId}</li>
              <li><strong>Email (si aplica):</strong> ${userEmail || 'No proporcionado'}</li>
              <li><strong>Teléfono (si aplica):</strong> ${userPhone}</li>
            </ul>
          </div>

          <div style="background-color: #fee2e2; padding: 15px; border-radius: 8px; border-left: 4px solid #ef4444;">
            <h3 style="margin-top: 0; color: #991b1b;">Resumen del problema:</h3>
            <p style="color: #7f1d1d; white-space: pre-wrap;">${summary}</p>
          </div>

          <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">
            Este es un correo automático generado por el asistente virtual de Llamalo AI.
          </p>
        </div>
      `,
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `✅ Ticket de soporte enviado a ${email}: ${info.messageId}`,
      );
      return { success: true, messageId: info.messageId };
    } catch (error) {
      this.logger.error(`❌ Error al enviar ticket de soporte:`, error);
      throw new Error(
        `No se pudo enviar el ticket de soporte: ${(error as Error).message}`,
      );
    }
  }
}
