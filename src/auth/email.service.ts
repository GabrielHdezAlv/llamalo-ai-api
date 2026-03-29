import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { MailerSend, EmailParams, Sender, Recipient } from 'mailersend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter?: nodemailer.Transporter;
  private mailerSend?: MailerSend;
  private useMailerSend = false;

  constructor() {
    // 1️⃣ Configurar MailerSend si hay API Key
    if (process.env.MAILERSEND_API_KEY) {
      this.logger.log('🚀 Inicializando servicio de email con MailerSend API...');
      this.mailerSend = new MailerSend({
        apiKey: process.env.MAILERSEND_API_KEY,
      });
      this.useMailerSend = true;
    } 
    // 2️⃣ Fallback a SMTP clásico
    else if (process.env.SMTP_PASS) {
      this.logger.log('📧 Inicializando servicio de email con Nodemailer (SMTP)...');
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER || 'team@llamalo.ai',
          pass: process.env.SMTP_PASS,
        },
      });
      this.logger.log(`SMTP service configurado con host: ${process.env.SMTP_HOST}`);
    } else {
      this.logger.error('❌ Ni MAILERSEND_API_KEY ni SMTP_PASS configuradas - email no funcionará');
    }
  }

  /**
   * Helper unificado para enviar emails
   */
  private async sendEmail(toEmail: string, subject: string, html: string, text: string): Promise<{ success: boolean; messageId?: string }> {
    if (this.useMailerSend && this.mailerSend) {
      try {
        const fromEmail = process.env.MAILERSEND_FROM_EMAIL || process.env.SMTP_USER || 'team@llamalo.ai';
        const fromName = process.env.MAILERSEND_FROM_NAME || 'Llamalo AI';
        
        const sentFrom = new Sender(fromEmail, fromName);
        const recipients = [new Recipient(toEmail)];
        
        const emailParams = new EmailParams()
          .setFrom(sentFrom)
          .setTo(recipients)
          .setSubject(subject)
          .setHtml(html)
          .setText(text);

        const response = await this.mailerSend.email.send(emailParams);
        return { success: true, messageId: 'enviado-por-mailersend' };
      } catch (error) {
        this.logger.error(`❌ Error enviando email vía MailerSend a ${toEmail}:`, error);
        throw new Error(`Error con MailerSend: ${(error as Error).message}`);
      }
    } else if (this.transporter) {
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
        this.logger.error(`❌ Error enviando email vía SMTP a ${toEmail}:`, error);
        throw new Error(`Error con SMTP: ${(error as Error).message}`);
      }
    } else {
      throw new Error('Servicio de email no está configurado (faltan credenciales de MailerSend o SMTP)');
    }
  }

  /**
   * Enviar email de verificación de cuenta
   */
  async sendVerificationEmail(email: string, verificationToken: string) {
    this.logger.log(`📧 Intentando enviar email de verificación a: ${email}`);

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
   * Verificar conexión con el servidor SMTP (o MailerSend)
   */
  async verifyConnection(): Promise<boolean> {
    if (this.useMailerSend && this.mailerSend) {
      return true;
    }
    
    if (this.transporter) {
      try {
        await this.transporter.verify();
        this.logger.log('Conexión SMTP verificada exitosamente');
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

    this.logger.log(`📧 Xenon enviando ticket de soporte a: ${emailTo}`);

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
