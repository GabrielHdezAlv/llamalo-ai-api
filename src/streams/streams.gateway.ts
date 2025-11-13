import { WebSocketGateway, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'ws';
import { ulawToPcm16, pcm16ToUlawB64 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { FishTtsHttpService } from '../fish-audio/http/fish-tts-http.service';
import { FishAsrHttpService } from '../fish-audio/http/fish-asr-http.service';
import { GptService } from '../llm/gpt.service';
import { TwilioCallMediaService } from '../twilio/twilio-call-media.service';
import type { FishAsrTranscript } from '../fish-audio/realtime/types';

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
  private readonly autoRespondEnabled =
    process.env.ENABLE_AUTO_RESPONSE === 'true';
  // Buffer para acumular audio HTTP antes de enviar a ASR
  private audioBuffers: Map<string, Buffer> = new Map();
  private audioBufferTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastUtteranceMeta: Map<string, FishAsrTranscript> = new Map();
  private httpQueues: Map<string, Promise<void>> = new Map();

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
      this.tts.onAudio(
        (
          pcm: Int16Array,
          info: {
            isFinal?: boolean;
            utteranceId?: string;
            sequenceId?: number;
            startMs?: number;
            endMs?: number;
          },
        ) => {
          if (!this.speaking) return;
          const ulawB64 = pcm16ToUlawB64(pcm);
          client.send(
            JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
          );
          recordMetric('tts', pcm.length / 8); // proxy de carga TTS
          const metaBits: string[] = [];
          if (info?.utteranceId) {
            metaBits.push(`utt ${info.utteranceId}`);
          }
          if (typeof info?.sequenceId === 'number') {
            metaBits.push(`seq ${info.sequenceId}`);
          }
          if (
            typeof info?.startMs === 'number' &&
            typeof info?.endMs === 'number'
          ) {
            metaBits.push(`win ${info.startMs}-${info.endMs}ms`);
          }
          if (info?.isFinal) {
            metaBits.push('final');
          }
          console.log(
            `🔊 [${callSid || 'no-sid'}] Audio TTS emitido (${pcm.length} samples)${
              metaBits.length ? ` [${metaBits.join(' | ')}]` : ''
            }`,
          );
        },
      );

      this.asr.onTranscript((t) => {
        const text = (t.text || '').trim();
        if (!text) return;

        const now = Date.now();
        if (lastAsrTime) recordMetric('asr', now - lastAsrTime);
        lastAsrTime = now;

        if (callSid) {
          this.lastUtteranceMeta.set(callSid, t);
        }

        console.log(
          `🎙️ [${callSid || 'no-sid'}] ASR: "${text}" (${t.is_final ? 'final' : 'partial'})` +
            (t.utterance_id ? ` [utt ${t.utterance_id}]` : ''),
        );

        this.speaking = false;
        if (!t.is_final) {
          console.log(
            `⏳ [${callSid || 'no-sid'}] Transcripción parcial recibida, esperando final…`,
          );
          return;
        }
        console.log(
          `✅ [${callSid || 'no-sid'}] Transcripción final detectada.`,
        );
        if (!this.autoRespondEnabled) {
          console.log(
            `🤖 [${callSid || 'no-sid'}] Respuesta automática deshabilitada, solo logging.`,
          );
          if (callSid) {
            this.lastUtteranceMeta.delete(callSid);
          }
          return;
        }
        this.speaking = true;
        void this.handleGptResponse(text, callSid, t);
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
          this.tts.cancelAll('interrupted-by-user-audio');
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
          this.tts.cancelAll('call-stop');

          // Flush cualquier audio pendiente antes de cerrar
          if (this.audioBuffers.has(callSid)) {
            void this.flushAudioBuffer(callSid, true);
          }

          client.close();
          console.log(`🛑 [${callSid}] Llamada terminada.`);
          if (callSid) {
            this.lastUtteranceMeta.delete(callSid);
          }
        }
      } catch (err) {
        console.error('❌ Error procesando mensaje Twilio:', err);
      }
    });
  }

  afterInit(server: Server) {
    console.log('🚀 StreamsGateway afterInit ejecutándose...');
    console.log('🔧 WebSocket server configurado correctamente');

    server.on('connection', (client: WebSocketClient) => {
      console.log('🛰️ Twilio WS conectado');
      console.log('📡 Nueva conexión WebSocket establecida');
      const startTime = Date.now();

      void Promise.all([this.asr.connect(), this.tts.connect()]).then(() => {
        console.log(`✅ ASR + TTS conectados en ${Date.now() - startTime}ms`);

        let callSid = '';
        let lastAsrTime = 0;

        this.tts.onAudio(
          (
            pcm: Int16Array,
            info: {
              isFinal?: boolean;
              utteranceId?: string;
              sequenceId?: number;
              startMs?: number;
              endMs?: number;
            },
          ) => {
            if (!this.speaking) return;
            const ulawB64 = pcm16ToUlawB64(pcm);
            client.send(
              JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
            );
            recordMetric('tts', pcm.length / 8); // proxy de carga TTS
            const metaBits: string[] = [];
            if (info?.utteranceId) {
              metaBits.push(`utt ${info.utteranceId}`);
            }
            if (typeof info?.sequenceId === 'number') {
              metaBits.push(`seq ${info.sequenceId}`);
            }
            if (
              typeof info?.startMs === 'number' &&
              typeof info?.endMs === 'number'
            ) {
              metaBits.push(`win ${info.startMs}-${info.endMs}ms`);
            }
            if (info?.isFinal) {
              metaBits.push('final');
            }
            console.log(
              `🔊 [${callSid || 'no-sid'}] Audio TTS emitido (${pcm.length} samples)${
                metaBits.length ? ` [${metaBits.join(' | ')}]` : ''
              }`,
            );
          },
        );

        this.asr.onTranscript((t) => {
          const text = (t.text || '').trim();
          if (!text) return;

          const now = Date.now();
          if (lastAsrTime) recordMetric('asr', now - lastAsrTime);
          lastAsrTime = now;

          if (callSid) {
            this.lastUtteranceMeta.set(callSid, t);
          }

          console.log(
            `🎙️ [${callSid || 'no-sid'}] ASR: "${text}" (${t.is_final ? 'final' : 'partial'})` +
              (t.utterance_id ? ` [utt ${t.utterance_id}]` : ''),
          );

          this.speaking = false;
          if (!t.is_final) {
            console.log(
              `⏳ [${callSid || 'no-sid'}] Transcripción parcial recibida, esperando final…`,
            );
            return;
          }
          console.log(
            `✅ [${callSid || 'no-sid'}] Transcripción final detectada.`,
          );
          if (!this.autoRespondEnabled) {
            console.log(
              `🤖 [${callSid || 'no-sid'}] Respuesta automática deshabilitada, solo logging.`,
            );
            if (callSid) {
              this.lastUtteranceMeta.delete(callSid);
            }
            return;
          }
          this.speaking = true;
          void this.handleGptResponse(text, callSid, t);
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
              this.tts.cancelAll('interrupted-by-user-audio');
              const pcm = ulawToPcm16(msg.media.payload);
              this.asr.sendPcm16(pcm);
            }

            if (msg.event === 'stop') {
              this.asr.stop();
              this.tts.cancelAll('call-stop');
              if (callSid && this.audioBuffers.has(callSid)) {
                void this.flushAudioBuffer(callSid, true);
              }
              client.close();
              console.log(`🛑 [${callSid}] Llamada terminada.`);
              if (callSid) {
                this.lastUtteranceMeta.delete(callSid);
              }
            }
          } catch (err) {
            console.error('Error procesando mensaje Twilio WS:', err);
          }
        });
      });
    });
  }

  private async handleGptResponse(
    text: string,
    callSid: string,
    transcript?: FishAsrTranscript,
  ): Promise<void> {
    try {
      const gptStart = Date.now();
      const utteranceId = transcript?.utterance_id;
      const sequenceId = transcript?.sequence_id;
      const startMs = transcript?.start_ms;
      const endMs = transcript?.end_ms;
      const isFinal = transcript?.is_final;
      const priority: number = transcript?.is_final ? 1 : 0;
      let wordBuffer = '';
      let sentenceBuffer = '';
      let firstToken = 0;
      let wordCount = 0;
      let chunkIndex = 0;

      if (utteranceId || typeof sequenceId === 'number') {
        console.log(
          `🧭 [${callSid}] Procesando respuesta GPT para utt ${
            utteranceId ?? 'sin-id'
          }${typeof sequenceId === 'number' ? ` seq ${sequenceId}` : ''}${
            typeof startMs === 'number' && typeof endMs === 'number'
              ? ` (${startMs}ms-${endMs}ms)`
              : ''
          }`,
        );
      }

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
            const queuedId = this.tts.sendText(textToSend, {
              utteranceId,
              sequenceId,
              priority,
              metadata: {
                callSid,
                chunkIndex,
                startMs,
                endMs,
                isFinalSource: isFinal,
                sentAt: Date.now(),
              },
            });
            recordMetric('tts', Date.now() - ttsStart);
            sentenceBuffer = '';
            wordCount = 0;
            chunkIndex += 1;
            if (queuedId) {
              const priorityLabel = priority.toString();
              console.log(
                '🗂️ [%s] TTS chunk en cola (%s) prioridad %s',
                callSid,
                queuedId,
                priorityLabel,
              );
            }
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
        const queuedId = this.tts.sendText(remaining, {
          utteranceId,
          sequenceId,
          priority,
          metadata: {
            callSid,
            chunkIndex,
            startMs,
            endMs,
            isFinalSource: isFinal,
            sentAt: Date.now(),
            finalChunk: true,
          },
        });
        recordMetric('tts', Date.now() - ttsStart);
        if (queuedId) {
          const priorityLabel = priority.toString();
          console.log(
            '🗂️ [%s] TTS chunk final en cola (%s) prioridad %s',
            callSid,
            queuedId,
            priorityLabel,
          );
        }
      }

      if (transcript?.is_final && callSid) {
        this.lastUtteranceMeta.delete(callSid);
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
      let pcmArray: Int16Array;
      try {
        // Convertir audio de Twilio a formato PCM
        pcm = ulawToPcm16(audioPayload);

        // Log para debugging y validación
        if (!pcm || pcm.length === 0) {
          console.warn(
            `⚠️ PCM inválido - length: ${pcm?.length || 0}, payload length: ${audioPayload.length}`,
          );
          return;
        }

        // Convertir a Int16Array si es necesario
        if (!(pcm instanceof Int16Array)) {
          // mulaw-js puede devolver un array normal, convertirlo a Int16Array
          const pcmAsAny = pcm as unknown as {
            constructor?: { name?: string };
            length?: number;
          };
          console.log(
            `⚠️ PCM no es Int16Array, convirtiendo... tipo: ${pcmAsAny?.constructor?.name || 'unknown'}, length: ${pcmAsAny?.length || 0}`,
          );
          try {
            pcmArray = new Int16Array(pcm as ArrayLike<number>);
          } catch (error) {
            console.error(
              '❌ Error convirtiendo array a Int16Array:',
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
        } else {
          pcmArray = pcm;
        }

        console.log(
          `✅ PCM generado: ${pcmArray.length} samples (${(pcmArray.length * 2).toFixed(0)} bytes)`,
        );
      } catch (error) {
        console.error(
          '❌ Error decodificando audio base64:',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      // Acumular chunks de audio en el buffer
      if (!this.audioBuffers.has(callSid)) {
        this.audioBuffers.set(callSid, Buffer.alloc(0));
      }

      const currentBuffer = this.audioBuffers.get(callSid)!;

      // Crear Buffer desde Int16Array de forma segura
      let pcmBuffer: Buffer;
      try {
        if (pcmArray.buffer && pcmArray.buffer instanceof ArrayBuffer) {
          pcmBuffer = Buffer.from(
            pcmArray.buffer,
            pcmArray.byteOffset,
            pcmArray.byteLength,
          );
          console.log(
            `✅ Buffer creado desde PCM: ${pcmBuffer.length} bytes (offset: ${pcmArray.byteOffset}, length: ${pcmArray.byteLength})`,
          );
        } else {
          console.warn(
            `⚠️ Usando método alternativo - PCM buffer: ${!!pcmArray.buffer}, buffer type: ${typeof pcmArray.buffer}`,
          );
          const tempArray = new Int16Array(pcmArray);
          pcmBuffer = Buffer.from(tempArray.buffer);
          console.log(
            `✅ Buffer alternativo creado: ${pcmBuffer.length} bytes`,
          );
        }
      } catch (error) {
        console.error(
          '❌ Error creando Buffer desde PCM:',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      const appendedBuffer = Buffer.concat([currentBuffer, pcmBuffer]);
      const chunkSizeBytes = 16000; // 1 segundo a 8kHz 16-bit mono
      const timeoutMs = 1000;

      const chunks: Buffer[] = [];
      let workingBuffer = appendedBuffer;

      while (workingBuffer.length >= chunkSizeBytes) {
        const chunk = Buffer.from(workingBuffer.slice(0, chunkSizeBytes));
        chunks.push(chunk);
        workingBuffer = workingBuffer.slice(chunkSizeBytes);
      }

      this.audioBuffers.set(callSid, workingBuffer);

      chunks.forEach((chunk, index) => {
        console.log(
          `🚀 [${callSid}] Encolando chunk HTTP #${index + 1} (${chunk.length} bytes)`,
        );
        this.enqueueHttpChunk(callSid, chunk);
      });

      const bufferSeconds = (workingBuffer.length / 16000).toFixed(2);
      console.log(
        `📦 Buffer restante: ${workingBuffer.length} bytes (${bufferSeconds}s)`,
      );

      const existingTimer = this.audioBufferTimers.get(callSid);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      if (workingBuffer.length > 0) {
        const timer = setTimeout(() => {
          const pending = this.audioBuffers.get(callSid);
          if (pending && pending.length > 0) {
            console.log(
              `⏰ Timeout HTTP — enviando chunk residual de ${pending.length} bytes`,
            );
            this.audioBuffers.set(callSid, Buffer.alloc(0));
            this.enqueueHttpChunk(callSid, Buffer.from(pending));
          }
        }, timeoutMs);
        this.audioBufferTimers.set(callSid, timer);
      } else {
        this.audioBufferTimers.delete(callSid);
      }
    } catch (error) {
      console.error('❌ Error procesando audio con HTTP:', error);
    }
  }

  private flushAudioBuffer(callSid: string, finalize = false): void {
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
        `📤 Enviando buffer residual HTTP: ${buffer.length} bytes (${(
          buffer.length / 16000
        ).toFixed(1)}s)`,
      );

      this.enqueueHttpChunk(callSid, Buffer.from(buffer), finalize);
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

  private enqueueHttpChunk(
    callSid: string,
    chunk: Buffer,
    finalize = false,
  ): void {
    const previous = this.httpQueues.get(callSid) ?? Promise.resolve();

    const next = previous
      .catch((error) => {
        console.error(
          `❌ [${callSid}] Error en chunk HTTP previo:`,
          error instanceof Error ? error.message : String(error),
        );
      })
      .then(() => this.processHttpChunk(callSid, chunk, finalize));

    this.httpQueues.set(callSid, next);

    void next.finally(() => {
      if (this.httpQueues.get(callSid) === next) {
        this.httpQueues.delete(callSid);
      }
    });
  }

  private async processHttpChunk(
    callSid: string,
    chunk: Buffer,
    finalize: boolean,
  ): Promise<void> {
    try {
      console.log(
        `📤 [${callSid}] Enviando chunk HTTP de ${chunk.length} bytes (${(
          chunk.length / 16000
        ).toFixed(2)}s)`,
      );

      const transcript = await this.asrHttp.transcribeAudio(chunk);

      if (transcript && transcript.trim()) {
        console.log(`🎙️ [${callSid}] ASR HTTP chunk: "${transcript}"`);
        await this.handleGptResponseHttp(transcript, callSid);
      } else {
        console.log(`🕸️ [${callSid}] Chunk HTTP sin transcripción utilizable.`);
      }

      if (finalize) {
        console.log(`✅ [${callSid}] Chunk HTTP final procesado.`);
      }
    } catch (error) {
      console.error(
        `❌ [${callSid}] Error procesando chunk HTTP:`,
        error instanceof Error ? error.message : String(error),
      );
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
