import { WebSocketGateway } from '@nestjs/websockets';
import { ulawToPcm16, pcm16ToUlawB64 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { FishTtsHttpService } from '../fish-audio/http/fish-tts-http.service';
import { FishAsrHttpService } from '../fish-audio/http/fish-asr-http.service';
import { GptService } from '../llm/gpt.service';
import { TwilioCallMediaService } from '../twilio/twilio-call-media.service';
import type { FishAsrTranscript } from '../fish-audio/realtime/types';

type TwilioMediaIn = { event: 'media'; media: { payload: string } };
type TwilioStart = { 
  event: 'start'; 
  start: { 
    callSid?: string;
    streamSid?: string;
    accountSid?: string;
    tracks?: string[];
    customParameters?: Record<string, unknown>;
    mediaFormat?: Record<string, unknown>;
  } 
};
type TwilioStop = { event: 'stop'; stop?: { accountSid?: string; callSid?: string } };
type TwilioConnected = { event: 'connected'; protocol?: string; version?: string };
type TwilioMsg = TwilioMediaIn | TwilioStart | TwilioStop | TwilioConnected;

interface WebSocketClient {
  send: (data: string) => void;
  on: (event: string, callback: (data: Buffer) => void) => void;
  close: () => void;
}

// Sesión por llamada para gestionar estado independiente
interface CallSession {
  callSid: string;
  speaking: boolean;
  useWebSocket: boolean;
  audioBuffer: Buffer;
  audioBufferTimer?: NodeJS.Timeout;
  httpQueue: Promise<void>;
  lastAsrTime: number;
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
export class StreamsGateway {
  private readonly autoRespondEnabled =
    process.env.ENABLE_AUTO_RESPONSE === 'true';
  // Gestión de sesiones por llamada
  private sessions: Map<string, CallSession> = new Map();

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

    // Intentar conectar ASR/TTS WebSocket
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

    let currentCallSid = '';
    let mediaBeforeStartWarned = false; // Para evitar logs repetitivos
    let mediaCount = 0; // Contador de eventos media

    client.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as TwilioMsg;
        
        // Incrementar contador de media
        if (msg.event === 'media') {
          mediaCount++;
        }
        
        // Solo mostrar evento si no es media repetitivo sin start
        if (!(msg.event === 'media' && !currentCallSid && mediaBeforeStartWarned)) {
          console.log('📨 Twilio mensaje recibido:', msg.event);
        }

        if (msg.event === 'connected') {
          console.log('🔗 Twilio WebSocket conectado:', JSON.stringify(msg, null, 2));
        }

        if (msg.event === 'start') {
          // Log completo para debugging
          console.log('📋 Mensaje completo del start:', JSON.stringify(msg, null, 2));
          
          currentCallSid = msg.start?.callSid || '';
          console.log(`🎯 CallSid recibido: "${currentCallSid}"`);
          console.log('🎯 StreamSid:', msg.start?.streamSid || 'N/A');
          
          // Reset flag cuando llegue el start
          mediaBeforeStartWarned = false;
          
          // Crear sesión para esta llamada
          if (currentCallSid) {
            this.createSession(currentCallSid, client, useWebSocket);
          } else {
            console.error('❌ No se pudo obtener callSid del evento start');
          }
        }

        if (msg.event === 'media') {
          // Si aún no tenemos callSid, esperar
          if (!currentCallSid) {
            if (!mediaBeforeStartWarned) {
              console.warn('⚠️ Recibiendo eventos media antes del start, esperando evento start... (este mensaje no se repetirá)');
              mediaBeforeStartWarned = true;
            }
            return;
          }

          const session = this.sessions.get(currentCallSid);
          if (!session) {
            console.warn(`⚠️ No hay sesión para callSid: "${currentCallSid}"`);
            console.warn(`⚠️ Sesiones disponibles: ${Array.from(this.sessions.keys()).join(', ')}`);
            return;
          }

          // Validar payload
          if (!msg.media?.payload) {
            console.warn('⚠️ Mensaje de media sin payload válido');
            return;
          }

          // Detener TTS cuando el usuario habla
          session.speaking = false;
          if (useWebSocket) {
            this.tts.cancelAll('interrupted-by-user-audio');
          }

          // Procesar audio según el modo
          if (session.useWebSocket && this.asr) {
            const pcm = ulawToPcm16(msg.media.payload);
            this.asr.sendPcm16(pcm);
          } else {
            void this.processAudioWithHttp(msg.media.payload, currentCallSid);
          }
        }

        if (msg.event === 'stop') {
          console.log(`🛑 [${currentCallSid || 'unknown'}] Llamada terminada.`);
          console.log(`📊 Resumen: ${mediaCount} eventos media recibidos, callSid: ${currentCallSid || 'nunca recibido'}`);
          
          if (currentCallSid) {
            this.cleanupSession(currentCallSid);
          } else {
            console.error('❌ PROBLEMA: La llamada terminó sin haber recibido el evento "start" de Twilio');
            console.error('📋 Esto indica que Twilio no está enviando el evento start correctamente');
          }
          client.close();
        }
      } catch (err) {
        console.error('❌ Error procesando mensaje Twilio:', err);
      }
    });
  }

  private createSession(callSid: string, client: WebSocketClient, useWebSocket: boolean) {
    console.log(`📝 [${callSid}] Creando nueva sesión`);

    const session: CallSession = {
      callSid,
      speaking: false,
      useWebSocket,
      audioBuffer: Buffer.alloc(0),
      httpQueue: Promise.resolve(),
      lastAsrTime: 0,
    };

    this.sessions.set(callSid, session);

    // Configurar callbacks de ASR y TTS solo si usamos WebSocket
    if (useWebSocket) {
      this.setupWebSocketCallbacks(callSid, client);
    }
  }

  private setupWebSocketCallbacks(callSid: string, client: WebSocketClient) {
    // Callback para audio TTS
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
        const session = this.sessions.get(callSid);
        if (!session || !session.speaking) return;

        const ulawB64 = pcm16ToUlawB64(pcm);
        client.send(
          JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
        );
        recordMetric('tts', pcm.length / 8);
        
        const metaBits: string[] = [];
        if (info?.utteranceId) metaBits.push(`utt ${info.utteranceId}`);
        if (typeof info?.sequenceId === 'number') metaBits.push(`seq ${info.sequenceId}`);
        if (typeof info?.startMs === 'number' && typeof info?.endMs === 'number') {
          metaBits.push(`win ${info.startMs}-${info.endMs}ms`);
        }
        if (info?.isFinal) metaBits.push('final');
        
        console.log(
          `🔊 [${callSid}] Audio TTS emitido (${pcm.length} samples)${
            metaBits.length ? ` [${metaBits.join(' | ')}]` : ''
          }`,
        );
      },
    );

    // Callback para transcripción ASR
    this.asr.onTranscript((t) => {
      const text = (t.text || '').trim();
      if (!text) return;

      const session = this.sessions.get(callSid);
      if (!session) return;

      const now = Date.now();
      if (session.lastAsrTime) recordMetric('asr', now - session.lastAsrTime);
      session.lastAsrTime = now;

      console.log(
        `🎙️ [${callSid}] ASR: "${text}" (${t.is_final ? 'final' : 'partial'})` +
          (t.utterance_id ? ` [utt ${t.utterance_id}]` : ''),
      );

      session.speaking = false;
      
      if (!t.is_final) {
        console.log(`⏳ [${callSid}] Transcripción parcial, esperando final…`);
        return;
      }
      
      console.log(`✅ [${callSid}] Transcripción final detectada.`);
      
      if (!this.autoRespondEnabled) {
        console.log(`🤖 [${callSid}] Respuesta automática deshabilitada.`);
        return;
      }
      
      session.speaking = true;
      void this.handleGptResponse(text, callSid, t);
    });
  }

  private cleanupSession(callSid: string) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    console.log(`🧹 [${callSid}] Limpiando sesión`);

    // Limpiar timer de audio buffer
    if (session.audioBufferTimer) {
      clearTimeout(session.audioBufferTimer);
    }

    // Detener ASR/TTS si están activos
    if (session.useWebSocket) {
      this.asr.stop();
      this.tts.cancelAll('call-stop');
    }

    this.sessions.delete(callSid);
  }

  private async handleGptResponse(
    text: string,
    callSid: string,
    transcript?: FishAsrTranscript,
  ): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(`⚠️ [${callSid}] No hay sesión activa para GPT`);
      return;
    }

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

      console.log(`🧭 [${callSid}] Procesando respuesta GPT`);

      for await (const token of this.gpt.streamReply(text)) {
        if (!session.speaking) break;
        
        if (!firstToken) {
          firstToken = Date.now();
          recordMetric('gpt', firstToken - gptStart);
          console.log(`⚡ [${callSid}] GPT primer token tras ${firstToken - gptStart}ms`);
        }

        wordBuffer += token;

        if (/[\s.!?,:;]/.test(token)) {
          sentenceBuffer += wordBuffer;
          wordBuffer = '';
          wordCount++;

          const shouldSend = wordCount >= 5 || /[.!?]\s*$/.test(sentenceBuffer.trim());

          if (shouldSend && sentenceBuffer.trim()) {
            let textToSend = sentenceBuffer.trim();
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
              console.log(`🗂️ [${callSid}] TTS chunk en cola (${queuedId}) prioridad ${priority}`);
            }
          }
        }
      }

      const total = Date.now() - gptStart;
      recordMetric('gpt', total);
      console.log(`✅ [${callSid}] GPT completado en ${total}ms`);

      // Enviar texto restante
      const remaining = (sentenceBuffer + wordBuffer).trim();
      if (session.speaking && remaining) {
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
          console.log(`🗂️ [${callSid}] TTS chunk final en cola (${queuedId}) prioridad ${priority}`);
        }
      }
    } catch (err) {
      console.error(`❌ [${callSid}] Error procesando respuesta GPT:`, err);
    }
  }

  private processAudioWithHttp(audioPayload: string, callSid: string): void {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(`⚠️ [${callSid}] No hay sesión para procesar audio HTTP`);
      return;
    }

    try {
      if (!audioPayload || typeof audioPayload !== 'string' || audioPayload.trim().length === 0) {
        console.warn('⚠️ Audio payload inválido o vacío');
        return;
      }

      let pcmArray: Int16Array;
      try {
        const pcm = ulawToPcm16(audioPayload);
        
        if (!pcm || pcm.length === 0) {
          console.warn(`⚠️ PCM inválido - length: ${pcm?.length || 0}`);
          return;
        }

        pcmArray = pcm instanceof Int16Array ? pcm : new Int16Array(pcm as ArrayLike<number>);
        console.log(`✅ PCM generado: ${pcmArray.length} samples (${(pcmArray.length * 2).toFixed(0)} bytes)`);
      } catch (error) {
        console.error('❌ Error decodificando audio:', error instanceof Error ? error.message : String(error));
        return;
      }

      // Crear buffer desde PCM
      let pcmBuffer: Buffer;
      try {
        pcmBuffer = Buffer.from(pcmArray.buffer, pcmArray.byteOffset, pcmArray.byteLength);
        console.log(`✅ Buffer creado: ${pcmBuffer.length} bytes`);
      } catch (error) {
        console.error('❌ Error creando Buffer:', error instanceof Error ? error.message : String(error));
        return;
      }

      // Acumular en el buffer de la sesión
      const appendedBuffer = Buffer.concat([session.audioBuffer, pcmBuffer]);
      const chunkSizeBytes = 16000; // 1 segundo a 8kHz 16-bit mono
      const timeoutMs = 1000;

      const chunks: Buffer[] = [];
      let workingBuffer = appendedBuffer;

      while (workingBuffer.length >= chunkSizeBytes) {
        const chunk = Buffer.from(workingBuffer.slice(0, chunkSizeBytes));
        chunks.push(chunk);
        workingBuffer = workingBuffer.slice(chunkSizeBytes);
      }

      session.audioBuffer = workingBuffer;

      chunks.forEach((chunk, index) => {
        console.log(`🚀 [${callSid}] Encolando chunk HTTP #${index + 1} (${chunk.length} bytes)`);
        this.enqueueHttpChunk(callSid, chunk);
      });

      const bufferSeconds = (workingBuffer.length / 16000).toFixed(2);
      console.log(`📦 Buffer restante: ${workingBuffer.length} bytes (${bufferSeconds}s)`);

      // Gestionar timer de timeout
      if (session.audioBufferTimer) {
        clearTimeout(session.audioBufferTimer);
      }

      if (workingBuffer.length > 0) {
        session.audioBufferTimer = setTimeout(() => {
          const currentSession = this.sessions.get(callSid);
          if (currentSession && currentSession.audioBuffer.length > 0) {
            console.log(`⏰ Timeout HTTP — enviando chunk residual de ${currentSession.audioBuffer.length} bytes`);
            const pending = Buffer.from(currentSession.audioBuffer);
            currentSession.audioBuffer = Buffer.alloc(0);
            this.enqueueHttpChunk(callSid, pending);
          }
        }, timeoutMs);
      }
    } catch (error) {
      console.error('❌ Error procesando audio con HTTP:', error);
    }
  }

  private flushAudioBuffer(callSid: string, finalize = false): void {
    const session = this.sessions.get(callSid);
    if (!session || session.audioBuffer.length === 0) {
      return;
    }

    try {
      console.log(
        `📤 Enviando buffer residual HTTP: ${session.audioBuffer.length} bytes (${(
          session.audioBuffer.length / 16000
        ).toFixed(1)}s)`,
      );

      const buffer = Buffer.from(session.audioBuffer);
      session.audioBuffer = Buffer.alloc(0);
      
      if (session.audioBufferTimer) {
        clearTimeout(session.audioBufferTimer);
        session.audioBufferTimer = undefined;
      }

      this.enqueueHttpChunk(callSid, buffer, finalize);
    } catch (error) {
      console.error('❌ Error flush audio buffer:', error);
    }
  }

  private async handleGptResponseHttp(
    text: string,
    callSid: string,
  ): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(`⚠️ [${callSid}] No hay sesión para GPT HTTP`);
      return;
    }

    try {
      console.log(`💬 [${callSid}] Generando respuesta GPT:`, text);

      let fullResponse = '';
      for await (const token of this.gpt.streamReply(text)) {
        fullResponse += token;
      }

      if (fullResponse.trim()) {
        console.log(`💬 [${callSid}] Respuesta GPT completa:`, fullResponse);

        // Generar audio con TTS HTTP
        const audioUrl = await this.ttsHttp.generateAudioAndUpload(
          fullResponse,
          'realtime',
        );

        // Reproducir con Twilio
        await this.twilioMedia.playUrl(callSid, audioUrl);
        console.log(`🎧 [${callSid}] Audio enviado a Twilio`);
      }
    } catch (error) {
      console.error(`❌ [${callSid}] Error manejando respuesta GPT HTTP:`, error);
    }
  }

  private enqueueHttpChunk(
    callSid: string,
    chunk: Buffer,
    finalize = false,
  ): void {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(`⚠️ [${callSid}] No hay sesión para encolar chunk HTTP`);
      return;
    }

    const previous = session.httpQueue;

    const next = previous
      .catch((error) => {
        console.error(
          `❌ [${callSid}] Error en chunk HTTP previo:`,
          error instanceof Error ? error.message : String(error),
        );
      })
      .then(() => this.processHttpChunk(callSid, chunk, finalize));

    session.httpQueue = next;
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
}
