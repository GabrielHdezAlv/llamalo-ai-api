import { WebSocketGateway, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'ws';
import { ulawToPcm16, pcm16ToUlawB64 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { GptService } from '../llm/gpt.service';

type TwilioMediaIn = { event: 'media'; media: { payload: string } };
type TwilioStart = { event: 'start'; start: { callSid?: string } };
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
  ) {}

  afterInit(server: Server) {
    server.on('connection', async (client: WebSocketClient) => {
      console.log('🛰️ Twilio WS conectado');

      // 1️⃣ Conectar ASR y TTS
      await Promise.all([this.asr.connect(), this.tts.connect()]);

      let callSid = '';

      // 2️⃣ Audio del TTS → se reenvía a Twilio
      this.tts.onAudio((pcm: Int16Array) => {
        if (!this.speaking) return;
        const ulawB64 = pcm16ToUlawB64(pcm);
        client.send(
          JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
        );
      });

      // 3️⃣ Procesar lo que el usuario dice
      this.asr.onTranscript((t) => {
        const text = (t.text || '').trim();
        if (!text) return;

        // Si el usuario habla, interrumpe cualquier respuesta TTS activa
        this.speaking = false;

        // ✅ Inicia GPT al tener algo de texto (sin esperar a que termine)
        if (t.is_final || text.length > 15) {
          if (!this.speaking) {
            this.speaking = true;
            void this.handleGptResponse(text);
          }
        }
      });

      // 4️⃣ Recibir eventos de Twilio
      client.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as TwilioMsg;

          if (msg.event === 'start') {
            callSid = msg.start?.callSid || '';
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
            console.log('🛑 Llamada terminada.');
          }
        } catch (err) {
          console.error('Error procesando mensaje Twilio WS:', err);
        }
      });
    });
  }

  /**
   * GPT → TTS (flujo en streaming)
   */
  private async handleGptResponse(text: string): Promise<void> {
    try {
      let buffer = '';

      for await (const token of this.gpt.streamReply(text)) {
        if (!this.speaking) break;
        buffer += token;

        // Envía frases parciales al TTS
        if (buffer.length > 80 || /[.!?]\s$/.test(buffer)) {
          console.log('💬 GPT parcial:', buffer);
          this.tts.sendText(buffer.trim());
          buffer = '';
        }
      }

      if (this.speaking && buffer.trim()) {
        this.tts.sendText(buffer.trim());
      }
    } catch (err) {
      console.error('❌ Error procesando respuesta GPT:', err);
    }
  }
}
