import { WebSocketGateway, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'ws';
import { ulawToPcm16 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { GptService } from '../llm/gpt.service';
import { TwilioCallMediaService } from 'src/twilio/twilio-call-media.service';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';

type TwilioMediaIn = { event: 'media'; media: { payload: string } };
type TwilioStart = { event: 'start'; start: unknown };
type TwilioStop = { event: 'stop' };
type TwilioMsg = TwilioMediaIn | TwilioStart | TwilioStop;

interface WebSocketClient {
  send: (data: string) => void;
  on: (event: string, callback: (data: Buffer) => void) => void;
  close: () => void;
}

@WebSocketGateway({ path: '/voice/stream' })
export class StreamsGateway implements OnGatewayInit {
  private speaking = false;
  constructor(
    private readonly asr: FishAsrService,
    private readonly tts: FishTtsService,
    private readonly gpt: GptService,
    private readonly twilioMedia: TwilioCallMediaService,
  ) {}

  private storage = admin.storage();

  afterInit(server: Server) {
    server.on('connection', async (client: WebSocketClient) => {
      console.log('🛰️ Twilio WS conectado');

      // 1️⃣ Conectar ASR y TTS de Fish
      await Promise.all([this.asr.connect(), this.tts.connect()]);

      // 2️⃣ Preparar variable para guardar el callSid de Twilio
      let callSid = '';

      // 3️⃣ Recibir los transcripts del ASR (voz del cliente)
      this.asr.onTranscript((t) => {
        const text = (t.text || '').trim();
        if (!text) return;

        if (t.is_final) {
          console.log('🗣️ Usuario dijo:', text);
          // ⬇️ Envía el texto a GPT y luego reproduce con Twilio
          void this.handleGptResponse(text, callSid);
        }
      });

      // 4️⃣ Escuchar eventos entrantes de Twilio (audio, start, stop)
      client.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as TwilioMsg;

          // Guarda el CallSid cuando llega el evento "start"
          if (msg.event === 'start' && (msg as any).start?.callSid) {
            callSid = (msg as any).start.callSid;
            console.log('🎯 CallSid recibido:', callSid);
          }

          if (msg.event === 'media') {
            this.speaking = false;
            const pcm = ulawToPcm16(msg.media.payload);
            this.asr.sendPcm16(pcm);
          }

          if (msg.event === 'stop') {
            this.asr.stop();
            client.close();
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });
    });
  }

  private async handleGptResponse(
    text: string,
    callSid: string,
  ): Promise<void> {
    try {
      let pending = '';

      for await (const token of this.gpt.streamReply(text)) {
        if (!this.speaking) break;
        pending += token;

        const flush = /[.!?]\s$/.test(pending) || pending.length > 120;
        if (flush) {
          console.log('💬 Respuesta parcial GPT:', pending);

          // 1️⃣ Generar audio
          const audioBuffer = await this.tts.generateAudioBuffer(pending);
          // 2️⃣ Subir a Firebase Storage
          const audioUrl = await this.uploadBufferToPublicUrl(audioBuffer);
          // 3️⃣ Reproducirlo al cliente con Twilio
          await this.twilioMedia.playUrl(callSid, audioUrl);

          pending = '';
        }
      }

      if (this.speaking && pending) {
        const audioBuffer = await this.tts.generateAudioBuffer(pending);
        const audioUrl = await this.uploadBufferToPublicUrl(audioBuffer);
        await this.twilioMedia.playUrl(callSid, audioUrl);
      }
    } catch (error) {
      console.error('❌ Error manejando respuesta GPT:', error);
    }
  }

  /**
   * Guarda un buffer de audio en Firebase Storage y devuelve su URL pública
   */
  private async uploadBufferToPublicUrl(buffer: Buffer, userId = 'realtime') {
    const bucket = this.storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const audioId = `${Date.now()}-${uuidv4()}.mp3`;
    const objectName = `audios/${userId}/${audioId}`;
    const file = bucket.file(objectName);

    await file.save(buffer, { metadata: { contentType: 'audio/mpeg' } });
    await file.makePublic();

    return `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${objectName}`;
  }
}
