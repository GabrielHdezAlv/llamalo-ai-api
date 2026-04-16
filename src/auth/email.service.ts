import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { SystemLogsService, LogType } from '../system-logs/system-logs.service';

function formatOutboundEmailError(error: unknown): string {
  if (error && typeof error === 'object' && error !== null) {
    const e = error as { message?: string; name?: string };
    if (typeof e.message === 'string') {
      return e.name ? `${e.name}: ${e.message}` : e.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter?: nodemailer.Transporter;
  private resend?: Resend;
  private useResend = false;

  constructor(private readonly systemLogsService: SystemLogsService) {
    if (process.env.RESEND_API_KEY) {
      this.logger.log('Inicializando envío de email con Resend API…');
      this.resend = new Resend(process.env.RESEND_API_KEY);
      this.useResend = true;
    } else if (process.env.SMTP_PASS) {
      this.logger.log('Inicializando servicio de email con Nodemailer (SMTP)…');
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'team@llamalo.ai',
          pass: process.env.SMTP_PASS,
        },
      });
      this.logger.log(`SMTP configurado (host: ${process.env.SMTP_HOST})`);
    } else {
      this.logger.error(
        'Ni RESEND_API_KEY ni SMTP_PASS configuradas: el envío de email no funcionará',
      );
    }
  }

  private getResendFromHeader(): string {
    const email =
      process.env.RESEND_FROM_EMAIL ||
      process.env.SMTP_USER ||
      'team@llamalo.ai';
    const name = process.env.RESEND_FROM_NAME || 'Llamalo AI';
    return `${name} <${email}>`;
  }

  /**
   * Helper unificado para enviar emails
   */
  private async sendEmail(
    toEmail: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<{ success: boolean; messageId?: string }> {
    if (this.useResend && this.resend) {
      try {
        const result = await this.resend.emails.send({
          from: this.getResendFromHeader(),
          to: [toEmail],
          subject,
          html,
          text,
        });

        if (result.error) {
          const detail = formatOutboundEmailError(result.error);
          this.logger.error(
            `Error enviando email vía Resend a ${toEmail}: ${detail}`,
            result.error,
          );
          await this.systemLogsService.logError({
            type: LogType.EMAIL_OUTBOUND_ERROR,
            message: `Error enviando email a ${toEmail}`,
            reason: detail,
            metadata: { toEmail, subject, provider: 'resend' },
          });
          throw new Error(`Error con Resend: ${detail}`);
        }

        return {
          success: true,
          messageId: result.data?.id,
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Error con Resend')) {
          throw error;
        }
        const detail = formatOutboundEmailError(error);
        this.logger.error(
          `Error enviando email vía Resend a ${toEmail}: ${detail}`,
          error,
        );
        await this.systemLogsService.logError({
          type: LogType.EMAIL_OUTBOUND_ERROR,
          message: `Error enviando email a ${toEmail}`,
          reason: detail,
          metadata: { toEmail, subject, provider: 'resend' },
        });
        throw new Error(`Error con Resend: ${detail}`);
      }
    }

    if (this.transporter) {
      try {
        const mailOptions = {
          from: `"Llamalo AI" <${process.env.SMTP_USER || 'team@llamalo.ai'}>`,
          to: toEmail,
          subject,
          text,
          html,
        };
        const info = await this.transporter.sendMail(mailOptions);
        return { success: true, messageId: info.messageId };
      } catch (error) {
        this.logger.error(`Error enviando email vía SMTP a ${toEmail}:`, error);
        throw new Error(`Error con SMTP: ${(error as Error).message}`);
      }
    }

    throw new Error(
      'Servicio de email no está configurado (faltan RESEND_API_KEY o SMTP_PASS)',
    );
  }

  /**
   * Enviar email de verificación de cuenta
   */
  async sendVerificationEmail(email: string, verificationToken: string) {
    this.logger.log(`Intentando enviar email de verificación a: ${email}`);

    const subject = 'Tu código de verificación de Llamalo AI';
    const text = `Tu código de verificación es: ${verificationToken}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #333;">Bienvenido a Llamalo AI</h1>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #333; margin-top: 0;">Verifica tu correo electrónico</h2>
          <p style="color: #666; line-height: 1.6;">
            Gracias por registrarte en Llamalo AI. Para activar tu cuenta, por favor introduce el siguiente código de verificación:
          </p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <div style="background-color: #f3f4f6; color: #1f2937; padding: 15px 30px; 
                      border-radius: 8px; display: inline-block; 
                      font-weight: bold; font-size: 32px; letter-spacing: 4px;">
            ${verificationToken}
          </div>
        </div>
        
        <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #856404;">
            <strong>Importante:</strong> Este código expirará en 24 horas. Si no verificas tu correo en este tiempo, 
            deberás solicitar un nuevo código de verificación.
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
    `;

    return this.sendEmail(email, subject, html, text);
  }

  /**
   * Enviar email de reenvío de verificación
   */
  async resendVerificationEmail(email: string, verificationToken: string) {
    return this.sendVerificationEmail(email, verificationToken);
  }

  /**
   * Código de 6 dígitos al iniciar sesión desde un dispositivo no registrado.
   */
  async sendDeviceVerificationEmail(email: string, code: string) {
    this.logger.log(`Código de nuevo dispositivo para: ${email}`);

    const subject = 'Nuevo dispositivo — código de verificación Llamalo AI';
    const text = `Tu código para confirmar este dispositivo es: ${code}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #333;">Confirmación de dispositivo</h1>
        <p style="color: #666; line-height: 1.6;">
          Alguien ha intentado iniciar sesión en Llamalo AI desde un dispositivo o navegador que aún no habíamos visto.
          Si fuiste tú, introduce este código en la pantalla de verificación:
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <div style="background-color: #f3f4f6; color: #1f2937; padding: 15px 30px;
                      border-radius: 8px; display: inline-block;
                      font-weight: bold; font-size: 32px; letter-spacing: 4px;">
            ${code}
          </div>
        </div>
        <p style="color: #856404; font-size: 14px;">
          El código caduca en 15 minutos. Si no has sido tú, cambia tu contraseña.
        </p>
      </div>
    `;

    return this.sendEmail(email, subject, html, text);
  }

  /**
   * Verificar conexión (Resend con API key o SMTP verify)
   */
  async verifyConnection(): Promise<boolean> {
    if (this.useResend && this.resend) {
      return true;
    }

    if (this.transporter) {
      try {
        await this.transporter.verify();
        this.logger.log('Conexión SMTP verificada correctamente');
        return true;
      } catch (error) {
        this.logger.error('Error al verificar conexión SMTP:', error);
        return false;
      }
    }

    return false;
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
    const emailTo = process.env.SUPPORT_EMAIL || 'team@llamalo.ai';

    this.logger.log(`Xenon enviando ticket de soporte a: ${emailTo}`);

    const subject = `🚨 [ESCALADO] Soporte requerido por usuario ${userId}`;
    const text = `
Un usuario ha solicitado asistencia humana a través del agente Xenon.

DETALLES DEL CLIENTE:
- ID de Usuario: ${userId}
- Teléfono de contacto: ${userPhone}

RESUMEN DEL PROBLEMA SEGÚN LA IA:
${summary}

---
Este es un correo automático generado por Xenon.
    `;
    const html = `
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
    `;

    return this.sendEmail(emailTo, subject, html, text);
  }
}
