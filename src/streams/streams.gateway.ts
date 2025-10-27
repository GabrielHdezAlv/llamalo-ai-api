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

// 🧠 Métricas acumuladas globales
const metrics = {
  asr: [] as number[],
  gpt: [] as number[],
  tts: [] as number[],
};

function recordMetric(type: keyof typeof metrics, ms: number) {
  metrics[type].push(ms);
  if (metrics[type].length > 2000) metrics[type].shift(); // mantiene ventana corta
}

function percentile95(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * sorted.length);
  return sorted[idx];
}

setInterval(() => {
  const logSummary = (type: keyof typeof metrics) => {
    const arr = metrics[type];
    if (!arr.length) return `0ms`;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const p95 = percentile95(arr);
    return `${avg.toFixed(0)}ms (p95 ${p95.toFixed(0)}ms)`;
  };

  console.log(
    `📊 Métricas — ASR ${logSummary('asr')} | GPT ${logSummary('gpt')} | TTS ${logSummary('tts')}`,
  );
}, 30_000);

@WebSocketGateway({
  path: '/voice/stream',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class StreamsGateway implements OnGatewayInit {
  private speaking = false;

  constructor(
    private readonly asr: FishAsrService,
    private readonly tts: FishTtsService,
    private readonly gpt: GptService,
  ) {}

  async handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');
    console.log('📡 Nueva conexión WebSocket establecida');
    
    // Verificar variables de entorno
    console.log('🔑 FISH_API_KEY:', process.env.FISH_API_KEY ? '✅ Configurado' : '❌ No configurado');
    console.log('🎤 FISH_TTS_VOICE_ID:', process.env.FISH_TTS_VOICE_ID || '❌ No configurado');
    console.log('🌍 FISH_LANG:', process.env.FISH_LANG || '❌ No configurado');
    
    const startTime = Date.now();

    try {
      await Promise.all([this.asr.connect(), this.tts.connect()]);
      console.log(`✅ ASR + TTS conectados en ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error('❌ Error conectando ASR/TTS:', error);
      throw error;
    }

    let callSid = '';
    let lastAsrTime = 0;

    this.tts.onAudio((pcm: Int16Array) => {
      if (!this.speaking) return;
      const ulawB64 = pcm16ToUlawB64(pcm);
      client.send(
        JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
      );
      recordMetric('tts', pcm.length / 8); // proxy de carga TTS
      console.log(
        `🔊 [${callSid || 'no-sid'}] Audio TTS emitido (${pcm.length} samples)`,
      );
    });

    this.asr.onTranscript((t) => {
      const text = (t.text || '').trim();
      if (!text) return;

      const now = Date.now();
      if (lastAsrTime) recordMetric('asr', now - lastAsrTime);
      lastAsrTime = now;

      console.log(
        `🎙️ [${callSid || 'no-sid'}] ASR: "${text}" (${t.is_final ? 'final' : 'partial'})`,
      );

      this.speaking = false;
      if (t.is_final || text.length > 15) {
        this.speaking = true;
        void this.handleGptResponse(text, callSid);
      }
    });

    client.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as TwilioMsg;
        console.log('📨 Twilio mensaje recibido:', msg.event);
        console.log('📋 Datos del mensaje:', JSON.stringify(msg, null, 2));

        if (msg.event === 'start') {
          callSid = msg.start?.callSid || '';
          console.log(`🎯 CallSid recibido: ${callSid}`);
          console.log('🎯 Start data completo:', msg.start);
        }

        if (msg.event === 'media') {
          this.speaking = false;
          const pcm = ulawToPcm16(msg.media.payload);
          this.asr.sendPcm16(pcm);
        }

        if (msg.event === 'stop') {
          this.asr.stop();
          client.close();
          console.log(`🛑 [${callSid}] Llamada terminada.`);
        }
      } catch (err) {
        console.error('❌ Error procesando mensaje Twilio:', err);
      }
    });
  }

  afterInit(server: Server) {
    console.log('🚀 StreamsGateway afterInit ejecutándose...');
    console.log('🔧 WebSocket server configurado correctamente');

    server.on('connection', async (client: WebSocketClient) => {
      console.log('🛰️ Twilio WS conectado');
      console.log('📡 Nueva conexión WebSocket establecida');
      const startTime = Date.now();

      await Promise.all([this.asr.connect(), this.tts.connect()]);
      console.log(`✅ ASR + TTS conectados en ${Date.now() - startTime}ms`);

      let callSid = '';
      let lastAsrTime = 0;

      this.tts.onAudio((pcm: Int16Array) => {
        if (!this.speaking) return;
        const ulawB64 = pcm16ToUlawB64(pcm);
        client.send(
          JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
        );
        recordMetric('tts', pcm.length / 8); // proxy de carga TTS
        console.log(
          `🔊 [${callSid || 'no-sid'}] Audio TTS emitido (${pcm.length} samples)`,
        );
      });

      this.asr.onTranscript((t) => {
        const text = (t.text || '').trim();
        if (!text) return;

        const now = Date.now();
        if (lastAsrTime) recordMetric('asr', now - lastAsrTime);
        lastAsrTime = now;

        console.log(
          `🎙️ [${callSid || 'no-sid'}] ASR: "${text}" (${t.is_final ? 'final' : 'partial'})`,
        );

        this.speaking = false;
        if (t.is_final || text.length > 15) {
          this.speaking = true;
          void this.handleGptResponse(text, callSid);
        }
      });

      client.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as TwilioMsg;
          console.log('📨 Twilio mensaje recibido:', msg.event);
          console.log('📋 Datos del mensaje:', JSON.stringify(msg, null, 2));

          if (msg.event === 'start') {
            callSid = msg.start?.callSid || '';
            console.log(`🎯 CallSid recibido: ${callSid}`);
            console.log('🎯 Start data completo:', msg.start);
          }

          if (msg.event === 'media') {
            this.speaking = false;
            const pcm = ulawToPcm16(msg.media.payload);
            this.asr.sendPcm16(pcm);
          }

          if (msg.event === 'stop') {
            this.asr.stop();
            client.close();
            console.log(`🛑 [${callSid}] Llamada terminada.`);
          }
        } catch (err) {
          console.error('Error procesando mensaje Twilio WS:', err);
        }
      });
    });
  }

  private async handleGptResponse(
    text: string,
    callSid: string,
  ): Promise<void> {
    try {
      const gptStart = Date.now();
      let buffer = '';
      let firstToken = 0;

      for await (const token of this.gpt.streamReply(text)) {
        if (!this.speaking) break;
        if (!firstToken) {
          firstToken = Date.now();
          recordMetric('gpt', firstToken - gptStart);
          console.log(
            `⚡ [${callSid}] GPT primer token tras ${firstToken - gptStart}ms`,
          );
        }

        buffer += token;
        if (buffer.length > 80 || /[.!?]\s$/.test(buffer)) {
          console.log(`💬 [${callSid}] GPT parcial: "${buffer.trim()}"`);
          const ttsStart = Date.now();
          this.tts.sendText(buffer.trim());
          recordMetric('tts', Date.now() - ttsStart);
          buffer = '';
        }
      }

      const total = Date.now() - gptStart;
      recordMetric('gpt', total);
      console.log(`✅ [${callSid}] GPT completado en ${total}ms`);

      if (this.speaking && buffer.trim()) {
        const ttsStart = Date.now();
        this.tts.sendText(buffer.trim());
        recordMetric('tts', Date.now() - ttsStart);
      }
    } catch (err) {
      console.error(`❌ [${callSid}] Error procesando respuesta GPT:`, err);
    }
  }
}
