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

  /**
   * Endpoint que Twilio llama al recibir una llamada entrante.
   * Devuelve TwiML (XML) para reproducir el audio de firstInteraction y abrir el stream.
   */
  @Post('incoming')
  async incoming(@Body() body: IncomingDto, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();

    console.log('📞 Llamada entrante desde:', body.From);

    const firestore = admin.firestore();

    try {
      // 🔹 Twilio envía números con prefijo internacional (ej: +34822272090)
      // eliminamos el prefijo +34 y lo convertimos a número para compararlo con phoneNumber
      const rawPhone = body.From?.replace('+34', '').replace(/\D/g, '');
      const phoneNumber = parseInt(rawPhone || '0', 10);

      console.log('🔍 Buscando usuario con phoneNumber:', phoneNumber);

      const userSnapshot = await firestore
        .collection('users')
        .where('phoneNumber', '==', phoneNumber)
        .limit(1)
        .get();

      if (!userSnapshot.empty) {
        const user = userSnapshot.docs[0].data();

        if (user.firstInteractionUrl) {
          console.log(
            '🔊 Reproduciendo audio personalizado:',
            user.firstInteractionUrl,
          );
          r.play(String(user.firstInteractionUrl || ''));
        } else if (user.firstInteraction) {
          console.log('🗣️ Usuario sin URL pero con texto de bienvenida.');
          // 🔸 Si en el futuro generas audio dinámico con Fish Audio:
          // const url = await this.fishAudioService.generateFirstInteraction(user.firstInteraction);
          // r.play(url);
          r.say(String(user.firstInteraction || ''));
        } else {
          console.log('⚠️ Usuario sin audio ni texto, usando por defecto.');
          r.play(
            'https://storage.googleapis.com/llamaloio.firebasestorage.app/audios/default.mp3',
          );
        }
      } else {
        console.log('⚠️ No se encontró usuario con ese número.');
        r.play(
          'https://storage.googleapis.com/llamaloio.firebasestorage.app/audios/default.mp3',
        );
      }
    } catch (error) {
      console.error('❌ Error al buscar usuario o reproducir audio:', error);
      r.play(
        'https://storage.googleapis.com/llamaloio.firebasestorage.app/audios/default.mp3',
      );
    }

    // 🚀 Iniciar el streaming de audio hacia tu backend (Fish Audio / WS)
    const start = r.start();
    const wsUrl =
      process.env.NODE_ENV === 'production'
        ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
        : 'ws://localhost:3000/voice/stream';

    start.stream({ url: wsUrl });

    // 🕓 Mantener la llamada activa (10 min)
    r.pause({ length: 600 });

    res.type('text/xml').send(r.toString());
  }
}
