import { WebSocketGateway, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'ws';
import { ulawToPcm16, pcm16ToUlawB64 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { FishTtsHttpService } from '../fish-audio/http/fish-tts-http.service';
import { FishAsrHttpService } from '../fish-audio/http/fish-asr-http.service';
import { GptService } from '../llm/gpt.service';
import { TwilioCallMediaService } from '../twilio/twilio-call-media.service';

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
  // Buffer para acumular audio HTTP antes de enviar a ASR
  private audioBuffers: Map<string, Buffer> = new Map();
  private audioBufferTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly asr: FishAsrService,
    private readonly tts: FishTtsService,
    private readonly ttsHttp: FishTtsHttpService,
    private readonly asrHttp: FishAsrHttpService,
    private readonly gpt: GptService,
    private readonly twilioMedia: TwilioCallMediaService,
  ) {}

  async handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');
    console.log('📡 Nueva conexión WebSocket establecida');

    // Verificar variables de entorno
    console.log(
      '🔑 FISH_API_KEY:',
      process.env.FISH_API_KEY ? '✅ Configurado' : '❌ No configurado',
    );
    console.log(
      '🎤 FISH_TTS_VOICE_ID:',
      process.env.FISH_TTS_VOICE_ID || '❌ No configurado',
    );
    console.log('🌍 FISH_LANG:', process.env.FISH_LANG || '❌ No configurado');

    const startTime = Date.now();

    let useWebSocket = false;
    try {
      await Promise.all([this.asr.connect(), this.tts.connect()]);
      console.log(`✅ ASR + TTS conectados en ${Date.now() - startTime}ms`);
      useWebSocket = true;
    } catch (error) {
      console.error('❌ Error conectando ASR/TTS:', error);
      console.log('🔄 Usando modo fallback HTTP...');
      useWebSocket = false;
    }

    let callSid = '';
    let lastAsrTime = 0;

    // Solo configurar callbacks si ASR/TTS están conectados
    if (this.asr && this.tts) {
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
    }

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
          console.log('🎵 Audio recibido de Twilio');

          // Validar que tenemos el payload de media
          if (!msg.media?.payload) {
            console.warn('⚠️ Mensaje de media sin payload válido');
            return;
          }

          if (useWebSocket && this.asr) {
            // Usar WebSocket si está disponible
            const pcm = ulawToPcm16(msg.media.payload);
            this.asr.sendPcm16(pcm);
          } else {
            // Usar HTTP fallback
            console.log('🔄 Procesando audio con HTTP fallback...');
            void this.processAudioWithHttp(msg.media.payload, callSid);
          }
        }

        if (msg.event === 'stop') {
          if (this.asr) {
            this.asr.stop();
          }

          // Flush cualquier audio pendiente antes de cerrar
          if (this.audioBuffers.has(callSid)) {
            void this.flushAudioBuffer(callSid);
          }

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
      let wordBuffer = '';
      let sentenceBuffer = '';
      let firstToken = 0;
      let wordCount = 0;

      for await (const token of this.gpt.streamReply(text)) {
        if (!this.speaking) break;
        if (!firstToken) {
          firstToken = Date.now();
          recordMetric('gpt', firstToken - gptStart);
          console.log(
            `⚡ [${callSid}] GPT primer token tras ${firstToken - gptStart}ms`,
          );
        }

        wordBuffer += token;

        // Cuando tenemos una palabra completa (termina con espacio o puntuación)
        if (/[\s.!?,:;]/.test(token)) {
          sentenceBuffer += wordBuffer;
          wordBuffer = '';
          wordCount++;

          // Enviar cada 5-10 palabras o al finalizar oración (según mejores prácticas de Fish Audio)
          const shouldSend =
            wordCount >= 5 || /[.!?]\s*$/.test(sentenceBuffer.trim());

          if (shouldSend && sentenceBuffer.trim()) {
            // Asegurar que terminamos con espacio (mejor práctica: palabras completas con espacios)
            let textToSend = sentenceBuffer.trim();
            // Solo agregar espacio si no termina con puntuación
            if (!/[.!?]$/.test(textToSend)) {
              textToSend += ' ';
            }
            console.log(`💬 [${callSid}] GPT streaming: "${textToSend}"`);
            const ttsStart = Date.now();
            this.tts.sendText(textToSend);
            recordMetric('tts', Date.now() - ttsStart);
            sentenceBuffer = '';
            wordCount = 0;
          }
        }
      }

      const total = Date.now() - gptStart;
      recordMetric('gpt', total);
      console.log(`✅ [${callSid}] GPT completado en ${total}ms`);

      // Enviar cualquier texto restante
      const remaining = (sentenceBuffer + wordBuffer).trim();
      if (this.speaking && remaining) {
        console.log(`💬 [${callSid}] GPT final: "${remaining}"`);
        const ttsStart = Date.now();
        this.tts.sendText(remaining);
        recordMetric('tts', Date.now() - ttsStart);
      }
    } catch (err) {
      console.error(`❌ [${callSid}] Error procesando respuesta GPT:`, err);
    }
  }

  private processAudioWithHttp(audioPayload: string, callSid: string): void {
    try {
      // Validar que tengamos payload válido
      if (!audioPayload || typeof audioPayload !== 'string') {
        console.warn('⚠️ Audio payload inválido o faltante');
        return;
      }

      // Validar que el payload no esté vacío
      if (audioPayload.trim().length === 0) {
        console.warn('⚠️ Audio payload vacío');
        return;
      }

      let pcm: Int16Array;
      try {
        // Convertir audio de Twilio a formato PCM
        pcm = ulawToPcm16(audioPayload);
      } catch (error) {
        console.error(
          '❌ Error decodificando audio base64:',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      // Validar que el PCM se haya generado correctamente
      if (!pcm || !pcm.buffer || pcm.length === 0) {
        console.warn(
          '⚠️ Error generando PCM desde audio payload - resultado inválido',
        );
        return;
      }

      // Acumular chunks de audio en el buffer
      if (!this.audioBuffers.has(callSid)) {
        this.audioBuffers.set(callSid, Buffer.alloc(0));
      }

      const currentBuffer = this.audioBuffers.get(callSid)!;
      const pcmBuffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const newBuffer = Buffer.concat([currentBuffer, pcmBuffer]);
      this.audioBuffers.set(callSid, newBuffer);

      // Limpiar timer anterior
      const existingTimer = this.audioBufferTimers.get(callSid);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Enviar a ASR cuando tengamos suficiente audio (3 segundos = 24000 bytes a 8kHz 16-bit mono)
      const minBufferSize = 24000 * 2; // 3 segundos de audio

      if (newBuffer.length >= minBufferSize) {
        // Enviar inmediatamente si tenemos suficiente
        void this.flushAudioBuffer(callSid);
      } else {
        // Configurar timer para enviar después de 2 segundos de silencio
        const timer = setTimeout(() => {
          void this.flushAudioBuffer(callSid);
        }, 2000);
        this.audioBufferTimers.set(callSid, timer);
      }
    } catch (error) {
      console.error('❌ Error procesando audio con HTTP:', error);
    }
  }

  private async flushAudioBuffer(callSid: string): Promise<void> {
    try {
      const buffer = this.audioBuffers.get(callSid);
      if (!buffer || buffer.length === 0) {
        return;
      }

      // Limpiar timers y buffer
      const timer = this.audioBufferTimers.get(callSid);
      if (timer) {
        clearTimeout(timer);
        this.audioBufferTimers.delete(callSid);
      }
      this.audioBuffers.delete(callSid);

      console.log(
        `📤 Enviando buffer de audio: ${buffer.length} bytes (${(buffer.length / 16000).toFixed(1)}s)`,
      );

      // Verificar que tengamos suficiente audio (al menos 1 segundo = 16000 bytes)
      const minAudioSize = 16000;
      if (buffer.length < minAudioSize) {
        console.log(
          `⏳ Audio demasiado corto (${buffer.length} bytes), esperando más...`,
        );
        // Re-agregar el buffer y continuar acumulando
        this.audioBuffers.set(callSid, buffer);
        return;
      }

      // Enviar PCM directamente sin convertir a WAV
      // Transcribir con ASR HTTP
      const transcript = await this.asrHttp.transcribeAudio(buffer);

      if (transcript && transcript.trim()) {
        console.log('🎙️ ASR HTTP:', transcript);

        // Generar respuesta con GPT
        await this.handleGptResponseHttp(transcript, callSid);
      }
    } catch (error) {
      console.error('❌ Error flush audio buffer:', error);
    }
  }

  private async handleGptResponseHttp(
    text: string,
    callSid: string,
  ): Promise<void> {
    try {
      console.log('💬 Generando respuesta GPT para:', text);

      // Generar respuesta completa con GPT
      let fullResponse = '';
      for await (const token of this.gpt.streamReply(text)) {
        fullResponse += token;
      }

      if (fullResponse.trim()) {
        console.log('💬 Respuesta GPT completa:', fullResponse);

        // Generar audio con TTS HTTP
        const audioUrl = await this.ttsHttp.generateAudioAndUpload(
          fullResponse,
          'realtime',
        );

        // Reproducir con Twilio
        await this.twilioMedia.playUrl(callSid, audioUrl);
      }
    } catch (error) {
      console.error('❌ Error manejando respuesta GPT HTTP:', error);
    }
  }

  private pcmToWav(pcm: Int16Array): Buffer {
    // Convertir PCM a WAV básico
    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcm.length * 2;
    const fileSize = 36 + dataSize;

    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // PCM data
    for (let i = 0; i < pcm.length; i++) {
      buffer.writeInt16LE(pcm[i], 44 + i * 2);
    }

    return buffer;
  }
}
