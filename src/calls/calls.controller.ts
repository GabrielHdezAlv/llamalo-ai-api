import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TwilioService } from './twilio.service';
import * as admin from 'firebase-admin';
import { TwilioCallMediaService } from '../twilio/twilio-call-media.service';

class IncomingDto {
  To?: string;
  From?: string;
  CallSid?: string;
}

@Controller('voice')
export class CallsController {
  constructor(
    private readonly twilio: TwilioService,
    private readonly twilioCallMedia: TwilioCallMediaService,
  ) {}

  @Post('incoming')
  async incoming(@Body() body: IncomingDto, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const firestore = admin.firestore();

    console.log('📞 Llamada entrante detectada');
    console.log('➡️ Número marcado (To):', body.To);
    console.log('➡️ Número del cliente (From):', body.From);

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

      const agent = agentSnapshot.docs[0].data();
      const twilioConfig = (agent.twilio as Record<string, unknown>) || {};

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

      // 🔹 IMPORTANTE: Start debe ir ANTES de Play para que Twilio envíe el evento "start"
      const wsUrl =
        process.env.NODE_ENV === 'production'
          ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
          : 'ws://localhost:3000/voice/stream';

      console.log('🔗 WebSocket URL:', wsUrl);
      
      // Crear y agregar el elemento Start con Stream PRIMERO
      // Especificar tracks: inbound (audio del usuario) y outbound (audio hacia el usuario)
      const start = r.start();
      start.stream({ 
        url: wsUrl,
        track: 'both_tracks' // inbound_track, outbound_track, o both_tracks
      });

      // Registrar credenciales para esta llamada (usar Twilio del agente)
      this.twilioCallMedia.registerCallCredentials(
        body.CallSid,
        twilioConfig.twilioSid as string | undefined,
        twilioConfig.twilioToken as string | undefined,
      );

      // 🔹 LUEGO reproducir audio o texto de bienvenida del agente
      if (twilioConfig.firstInteractionUrl) {
        console.log(
          '🔊 Reproduciendo audio personalizado:',
          twilioConfig.firstInteractionUrl,
        );
        r.play(
          typeof twilioConfig.firstInteractionUrl === 'string'
            ? twilioConfig.firstInteractionUrl
            : '',
        );
      } else if (twilioConfig.firstInteraction) {
        console.log('🗣️ Reproduciendo texto de bienvenida');
        (r.say as any)(
          typeof twilioConfig.firstInteraction === 'string'
            ? twilioConfig.firstInteraction
            : 'Bienvenido a LlamaloAI.',
          { voice: 'alice', language: 'es-ES' },
        );
      } else {
        console.log('⚠️ Sin configuración, usando audio por defecto');
        r.play(
          'https://storage.googleapis.com/llamaloio.firebasestorage.app/audios/default.mp3',
        );
      }

      // 🔹 Mantener llamada viva (10 minutos)
      r.pause({ length: 600 });

      // Debug: mostrar TwiML generado
      const twimlString = r.toString();
      console.log('📄 TwiML generado:', twimlString);
      console.log('✅ TwiML generado correctamente.');
      res.type('text/xml').send(twimlString);
    } catch (error) {
      console.error('❌ Error al procesar la llamada entrante:', error);
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
  async resume(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const wsUrl =
      process.env.NODE_ENV === 'production'
        ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
        : 'ws://localhost:3000/voice/stream';

    console.log('🔄 Reanudando stream Twilio');
    console.log('🔁 CallSid reanudado:', body?.CallSid || 'desconocido');

    const start = r.start();
    start.stream({
      url: wsUrl,
      track: 'both_tracks',
    });

    r.pause({ length: 600 });

    const twimlString = r.toString();
    console.log('📄 TwiML resume generado:', twimlString);
    res.type('text/xml').send(twimlString);
  }
}
