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
        if (
          error instanceof Error &&
          error.message.startsWith('Error con Resend')
        ) {
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
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&amp;display=swap" />
      <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #e8ecf4; padding: 28px 14px;">
        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #dce3ee; box-shadow: 0 12px 40px rgba(27, 37, 89, 0.1);">
          <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: linear-gradient(145deg, #1b2559 0%, #121832 42%, #1e3a62 100%); padding: 36px 24px 32px; text-align: center;">
            <img src="https://app.llamalo.ai/assets/logo_blanco.png" alt="Llamalo AI" width="112" style="display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;height:auto;max-width:112px;width:112px;" />
            <h1 style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; color: #ffffff; font-size: 26px; line-height: 1.2; font-weight: 700;">Bienvenido a Llamalo AI</h1>
            <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 14px 0 0; font-size: 14px; line-height: 1.45; color: rgba(191, 219, 254, 0.95);">Verificación de correo electrónico</p>
            <div style="margin: 22px auto 0; max-width: 280px; height: 3px; border-radius: 999px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent);"></div>
          </div>

          <div style="padding: 28px 24px 8px;">
            <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6fb; padding: 22px 20px; border-radius: 12px; margin-bottom: 8px; border: 1px solid #e2e8f0;">
              <h2 style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1b2559; margin: 0 0 12px; font-size: 18px; line-height: 1.3; font-weight: 700;">Verifica tu correo electrónico</h2>
              <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #475569; line-height: 1.65; margin: 0; font-size: 15px;">
                Gracias por registrarte en Llamalo AI. Para activar tu cuenta, introduce el siguiente código de verificación en la aplicación:
              </p>
            </div>

            <div style="text-align: center; margin: 28px 0 26px;">
              <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: linear-gradient(180deg, #ffffff 0%, #f1f4ff 100%); color: #1b2559; padding: 18px 36px;
                          border-radius: 12px; display: inline-block; border: 2px solid #c7d2e8;
                          font-weight: 700; font-size: 32px; letter-spacing: 0.28em; font-variant-numeric: tabular-nums;
                          box-shadow: 0 4px 14px rgba(27, 37, 89, 0.08);">
                ${verificationToken}
              </div>
              <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 14px 0 0; font-size: 12px; color: #94a3b8;">Código de un solo uso</p>
            </div>

            <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f0f4ff; border-left: 4px solid #1b2559; padding: 16px 18px; margin: 0 0 8px; border-radius: 0 10px 10px 0;">
              <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; color: #334155; line-height: 1.6; font-size: 14px;">
                <strong style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1b2559;">Importante:</strong> este código caduca a las <strong style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1b2559;">24 horas</strong>.
                Si no verificas tu correo en ese plazo, deberás solicitar un nuevo código desde el registro.
              </p>
            </div>
          </div>

          <div style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #fafbfc; border-top: 1px solid #e8ecf0; padding: 22px 24px 26px;">
            <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #94a3b8; font-size: 12px; text-align: center; margin: 0; line-height: 1.5;">
              Si no te registraste en Llamalo AI, ignora este mensaje.
            </p>
            <p style="font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #cbd5e1; font-size: 11px; text-align: center; margin: 12px 0 0; line-height: 1.5;">
              © 2026 Llamalo AI · Todos los derechos reservados
            </p>
          </div>
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
   * Envía al usuario el enlace a la factura pagada en Stripe (vía Resend).
   */
  async sendStripeInvoiceReceiptEmail(params: {
    to: string;
    invoiceNumber: string | null;
    amountPaidFormatted: string;
    currency: string;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
  }): Promise<{ success: boolean; messageId?: string }> {
    const {
      to,
      invoiceNumber,
      amountPaidFormatted,
      hostedInvoiceUrl,
      invoicePdfUrl,
    } = params;
    const subject = `Factura Llamalo AI${invoiceNumber ? ` ${invoiceNumber}` : ''}`;
    const lines: string[] = [
      `Importe pagado: ${amountPaidFormatted} ${params.currency.toUpperCase()}`,
    ];
    if (hostedInvoiceUrl) {
      lines.push(`Ver factura: ${hostedInvoiceUrl}`);
    }
    if (invoicePdfUrl) {
      lines.push(`PDF: ${invoicePdfUrl}`);
    }
    const text = lines.join('\n');

    const safeNum = invoiceNumber
      ? String(invoiceNumber).replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : '';
    const links: string[] = [];
    if (hostedInvoiceUrl) {
      links.push(
        `<p><a href="${hostedInvoiceUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Ver factura</a></p>`,
      );
    }
    if (invoicePdfUrl) {
      links.push(
        `<p><a href="${invoicePdfUrl}" style="color:#2563eb;">Descargar PDF</a></p>`,
      );
    }

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #111; font-size: 20px;">Factura pagada</h1>
        <p style="color: #444; line-height: 1.6;">
          Gracias por tu pago. Resumen de tu factura${safeNum ? ` <strong>${safeNum}</strong>` : ''}.
        </p>
        <p style="font-size: 18px; color: #111;"><strong>${amountPaidFormatted}</strong>
          <span style="color:#666;">${params.currency.toUpperCase()}</span></p>
        ${links.join('\n')}
        <p style="color: #999; font-size: 12px; margin-top: 24px;">
          Dudas sobre el cobro: team@llamalo.ai
        </p>
      </div>
    `;

    this.logger.log(`Recibo de factura Stripe → ${to}`);
    return this.sendEmail(to, subject, html, text);
  }

  /**
   * Aviso cuando Stripe no puede cobrar una factura (invoice.payment_failed).
   */
  async sendStripePaymentFailedEmail(params: {
    to: string;
    invoiceNumber: string | null;
    amountDueFormatted: string;
    currency: string;
    hostedInvoiceUrl: string | null;
  }): Promise<{ success: boolean; messageId?: string }> {
    const { to, invoiceNumber, amountDueFormatted, hostedInvoiceUrl } = params;
    const subject = `Problema con el pago — Llamalo AI${invoiceNumber ? ` (${invoiceNumber})` : ''}`;
    const lines: string[] = [
      `No se ha podido cobrar el importe pendiente: ${amountDueFormatted} ${params.currency.toUpperCase()}.`,
      'Actualiza tu método de pago o revisa la factura para seguir usando el servicio sin interrupciones.',
    ];
    if (hostedInvoiceUrl) {
      lines.push(`Gestionar pago: ${hostedInvoiceUrl}`);
    }
    lines.push('Si ya regularizaste el pago, ignora este mensaje.');
    const text = lines.join('\n');

    const safeNum = invoiceNumber
      ? String(invoiceNumber).replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : '';
    const payBlock = hostedInvoiceUrl
      ? `<p><a href="${hostedInvoiceUrl}" style="display:inline-block;background:#b45309;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Revisar factura y pago</a></p>`
      : '';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #92400e; font-size: 20px;">No hemos podido cobrar tu última factura</h1>
        <p style="color: #444; line-height: 1.6;">
          El cobro no se ha completado${safeNum ? ` (factura <strong>${safeNum}</strong>)` : ''}.
          Mientras la factura siga impagada, el acceso a Llamalo AI puede quedar limitado según tu suscripción.
        </p>
        <p style="font-size: 18px; color: #111;"><strong>${amountDueFormatted}</strong>
          <span style="color:#666;">${params.currency.toUpperCase()}</span> pendiente</p>
        ${payBlock}
        <p style="color: #666; font-size: 14px;">
          Actualiza tu tarjeta o método de pago desde el enlace anterior.
        </p>
        <p style="color: #999; font-size: 12px; margin-top: 24px;">
          Dudas: team@llamalo.ai
        </p>
      </div>
    `;

    this.logger.log(`Aviso pago fallido Stripe → ${to}`);
    return this.sendEmail(to, subject, html, text);
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
