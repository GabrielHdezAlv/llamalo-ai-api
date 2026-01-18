import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TwilioService } from './twilio.service';
import * as admin from 'firebase-admin';

class IncomingDto {
  To?: string;
  From?: string;
  CallSid?: string;
}

@Controller('voice')
export class CallsController {
  constructor(private readonly twilio: TwilioService) {}

  // 🔒 Helper para enmascarar números de teléfono
  private maskPhoneNumber(phone?: string): string {
    if (!phone) return 'N/A';
    // Mostrar solo los últimos 4 dígitos: +34****1234
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 4) return '****';
    return `${phone.substring(0, phone.length - 4)}****`;
  }

  @Post('incoming')
  async incoming(@Body() body: IncomingDto, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const firestore = admin.firestore();

    console.log('📞 Llamada entrante detectada');
    // 🔒 Enmascarar números de teléfono para proteger privacidad
    console.log('➡️ Número marcado (To):', this.maskPhoneNumber(body.To));
    console.log('➡️ Número del cliente (From):', this.maskPhoneNumber(body.From));

    try {
      // 🔹 Buscar agente por su número Twilio (body.To)
      const rawNumber = body.To?.replace('+34', '').replace(/\D/g, '');
      const agentNumber = parseInt(rawNumber || '0', 10);

      console.log('🔍 Buscando agente con twilio.phoneNumber:', agentNumber);

      const agentSnapshot = await firestore
        .collection('users')
        .where('twilio.phoneNumber', '==', agentNumber)
        .limit(1)
        .get();

      if (agentSnapshot.empty) {
        console.log('⚠️ No se encontró ningún agente con ese número.');
        (r.say as any)(
          'El número de agente no está configurado. Inténtelo más tarde.',
          {
            voice: 'alice',
            language: 'es-ES',
          },
        );
        return res.type('text/xml').send(r.toString());
      }

      const agentDoc = agentSnapshot.docs[0];
      const userId = agentDoc.id;
      const agent = agentDoc.data();
      const twilioConfig = (agent.twilio as Record<string, unknown>) || {};
      
      // Obtener shopDomain de integrations.shopify si existe
      const integrations = (agent.integrations as Record<string, unknown>) || {};
      const shopifyIntegration = (integrations.shopify as Record<string, unknown>) || {};
      const shopDomain =
        typeof shopifyIntegration.shopDomain === 'string'
          ? shopifyIntegration.shopDomain
          : undefined;

      // 🔍 Logging para debugging de Shopify
      if (!integrations || Object.keys(integrations).length === 0) {
        console.log(`⚠️ [Calls] Usuario ${userId} no tiene integraciones configuradas`);
      } else if (!shopifyIntegration || Object.keys(shopifyIntegration).length === 0) {
        console.log(`⚠️ [Calls] Usuario ${userId} no tiene integración Shopify configurada`);
      } else if (!shopDomain) {
        console.log(`⚠️ [Calls] Usuario ${userId} tiene integración Shopify pero no shopDomain. Datos:`, {
          connected: shopifyIntegration.connected,
          shopDomain: shopifyIntegration.shopDomain,
        });
      } else {
        console.log(`✅ [Calls] ShopDomain encontrado para usuario ${userId}: ${shopDomain}`);
      }

      // // 🔹 Verificar antigüedad de la cuenta (deshabilitado temporalmente)
      // if (agent.createdAt) {
      //   const createdAt = (
      //     agent.createdAt as admin.firestore.Timestamp
      //   ).toDate();
      //   const diffDays =
      //     (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24);
      //
      //   if (diffDays >= 7) {
      //     console.log(
      //       `❌ Cuenta con ${diffDays.toFixed(0)} días — llamada no permitida.`,
      //     );
      //     (r.say as any)(
      //       'Su cuenta tiene más de 7 días de antigüedad. No puede realizar esta llamada.',
      //       { voice: 'alice', language: 'es-ES' },
      //     );
      //     return res.type('text/xml').send(r.toString());
      //   }
      // }

      const wsUrl =
        process.env.NODE_ENV === 'production'
          ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
          : 'ws://localhost:3000/voice/stream';

      const connect = r.connect();
      const stream = connect.stream({
        url: wsUrl,
        track: 'inbound_track',
      });

      const addStreamParameter = (name: string, value?: string) => {
        if (!value) return;
        const normalized = value.trim();
        if (!normalized) return;
        // Para instructions, usar límite mucho más alto; para otros parámetros mantener 450
        const limit = name === 'instructions' ? 50000 : 450;
        stream.parameter({
          name,
          value: normalized.slice(0, limit),
        });
      };

      const agentProfile =
        (agent?.agent as Record<string, unknown>) ||
        ({} as Record<string, unknown>);
      const agentName =
        typeof agentProfile.name === 'string'
          ? agentProfile.name
          : typeof agent?.name === 'string'
            ? agent.name
            : undefined;

      addStreamParameter('agentName', agentName);
      addStreamParameter(
        'greeting',
        typeof twilioConfig.firstInteraction === 'string'
          ? twilioConfig.firstInteraction
          : undefined,
      );
      addStreamParameter(
        'greetingUrl',
        typeof twilioConfig.firstInteractionUrl === 'string'
          ? twilioConfig.firstInteractionUrl
          : undefined,
      );
      addStreamParameter(
        'instructions',
        typeof twilioConfig.agentInstruction === 'string'
          ? twilioConfig.agentInstruction
          : undefined,
      );
      addStreamParameter(
        'labsId',
        typeof agentProfile.labsId === 'string'
          ? agentProfile.labsId
          : undefined,
      );
      addStreamParameter(
        'language',
        typeof (agentProfile.language as Record<string, unknown>)?.code ===
          'string'
          ? ((agentProfile.language as Record<string, unknown>).code as string)
          : undefined,
      );

      // Agregar userId y shopDomain como customParameters para Shopify
      addStreamParameter('userId', userId);
      if (shopDomain) {
        addStreamParameter('shopDomain', shopDomain);
        console.log(`✅ [Calls] ShopDomain agregado a parámetros de stream: ${shopDomain}`);
      } else {
        console.warn(`⚠️ [Calls] ShopDomain no agregado (no está configurado para usuario ${userId})`);
      }

      // ✅ TwiML generado correctamente (sin loggear el contenido completo)
      const twimlString = r.toString();
      console.log('✅ TwiML generado correctamente (longitud:', twimlString.length, 'caracteres)');
      res.type('text/xml').send(twimlString);
    } catch (error) {
      // 🔒 No loggear el error completo que podría contener información sensible
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      console.error('❌ Error al procesar la llamada entrante:', errorMessage);
      (r.say as any)(
        'Ha ocurrido un error interno. Por favor, inténtelo más tarde.',
        {
          voice: 'alice',
          language: 'es-ES',
        },
      );
      res.type('text/xml').send(r.toString());
    }
  }

  @Post('resume')
  resume(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const wsUrl =
      process.env.NODE_ENV === 'production'
        ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
        : 'ws://localhost:3000/voice/stream';

    console.log('🔄 Reanudando stream Twilio');
    console.log('🔁 CallSid reanudado:', body?.CallSid || 'desconocido');

    const connect = r.connect();
    connect.stream({
      url: wsUrl,
      track: 'inbound_track',
    });

    const twimlString = r.toString();
    // ✅ Solo loggear longitud, no el contenido completo
    console.log('📄 TwiML resume generado (longitud:', twimlString.length, 'caracteres)');
    res.type('text/xml').send(twimlString);
  }
}
