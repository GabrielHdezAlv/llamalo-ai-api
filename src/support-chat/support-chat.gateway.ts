import { Injectable, Logger } from '@nestjs/common';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { SupportChatService } from './support-chat.service';
import type { SupportAgentConfigResponseDto } from './dto/support-chat.dto';

// ── Types ────────────────────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: string };

export interface SupportChatClient {
  send: (data: string | Buffer) => void;
  close: () => void;
}

interface SupportVoiceSession {
  sessionId: string;
  userId: string;
  client: SupportChatClient;
  config: SupportAgentConfigResponseDto;
  deepgramSocket?: WebSocket;
  readyForAudio: boolean;
  queuedAudio: Buffer[];
  history: Message[];
  knowledgeSourceIds: string[];
  agentSpeaking: boolean;
  interrupted: boolean;
  allowInterruptions: boolean;
  ttsCancelStream?: () => void;
  currentTTSRequest?: Promise<void>;
  greetingSent: boolean;
  greetingPlaybackDone: boolean;
  createdAt: number;
  sessionTimeout?: NodeJS.Timeout;
  keepAliveTimer?: NodeJS.Timeout;
  pendingTranscript: string;
  transcriptDebounceTimer?: NodeJS.Timeout;
  llmProcessing: boolean;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

type IncomingMessage =
  | { type: 'session.start'; token: string }
  | { type: 'audio'; data: string }
  | { type: 'session.end' };

// ── Gateway ──────────────────────────────────────────────────────────────────

@Injectable()
export class SupportChatGateway {
  private readonly logger = new Logger(SupportChatGateway.name);

  private sessions = new Map<string, SupportVoiceSession>();
  private clientToSession = new Map<SupportChatClient, string>();
  private userSessions = new Map<string, string>();
  private rateLimits = new Map<string, RateLimitEntry>();

  private readonly MAX_SESSION_MS = 5 * 60 * 1000;
  private readonly MAX_CALLS_PER_HOUR = 10;
  private readonly MAX_CONCURRENT = 10;
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  private readonly KEEPALIVE_MS = 15_000;
  private readonly MAX_BUFFERED_CHUNKS = 25;
  private readonly TRANSCRIPT_DEBOUNCE_MS = 400;

  private readonly elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  private readonly elevenLabsBaseUrl =
    process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1';
  private readonly elevenLabsTtsModelId =
    process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_multilingual_v2';
  private readonly defaultVoiceId =
    process.env.ELEVENLABS_TTS_VOICE_ID ?? '15bJsujCI3tcDWeoZsQP';
  private readonly defaultStability = Number(
    process.env.ELEVENLABS_TTS_STABILITY ?? 0.5,
  );
  private readonly defaultSimilarity = Number(
    process.env.ELEVENLABS_TTS_SIMILARITY ?? 0.8,
  );
  private readonly defaultStyle = Number(
    process.env.ELEVENLABS_TTS_STYLE ?? 0.05,
  );
  private readonly defaultBoost =
    (process.env.ELEVENLABS_TTS_SPEAKER_BOOST ?? 'true') === 'true';
  private readonly defaultSpeed = Number(
    process.env.ELEVENLABS_TTS_VOICE_SPEED ?? 0.98,
  );

  private readonly deepgramApiKey =
    process.env.DG_VOICE_AGENT_API_KEY ?? process.env.DG_API_KEY;
  private readonly deepgramUrl =
    process.env.DG_VOICE_AGENT_URL ||
    'wss://agent.deepgram.com/v1/agent/converse';
  private readonly deepgramListenModel =
    process.env.DG_LISTEN_MODEL ?? 'nova-3';

  private readonly openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  private readonly ttsOutputFormat = 'pcm_16000';

  constructor(private readonly supportChatService: SupportChatService) {}

  // ── Conexión WebSocket ─────────────────────────────────────────────────────

  handleConnection(
    client: SupportChatClient,
    onMessage: (handler: (raw: Buffer) => void) => void,
  ) {
    this.logger.log('💬 [SupportVoice] Nueva conexión WebSocket');
    let currentSessionId: string | null = null;

    onMessage((raw: Buffer) => {
      void (async () => {
        try {
          let msg: IncomingMessage;
          try {
            msg = JSON.parse(raw.toString()) as IncomingMessage;
          } catch {
            if (currentSessionId) {
              this.forwardAudioToDeepgram(currentSessionId, raw);
            }
            return;
          }

          switch (msg.type) {
            case 'session.start': {
              if (currentSessionId) {
                this.sendJson(client, {
                  type: 'error',
                  message: 'Sesión ya activa',
                });
                return;
              }
              const result = await this.startSession(client, msg.token);
              if (result) {
                currentSessionId = result;
              }
              break;
            }
            case 'audio': {
              if (currentSessionId && msg.data) {
                const chunk = Buffer.from(msg.data, 'base64');
                this.forwardAudioToDeepgram(currentSessionId, chunk);
              }
              break;
            }
            case 'session.end': {
              if (currentSessionId) {
                this.endSession(currentSessionId, 'user');
                currentSessionId = null;
              }
              break;
            }
          }
        } catch (err) {
          this.logger.error('❌ [SupportVoice] Error procesando mensaje:', err);
        }
      })();
    });
  }

  handleDisconnect(client: SupportChatClient) {
    const sessionId = this.clientToSession.get(client);
    if (sessionId) {
      this.endSession(sessionId, 'disconnect');
    }
  }

  // ── Inicio de sesión ──────────────────────────────────────────────────────

  private async startSession(
    client: SupportChatClient,
    token: string,
  ): Promise<string | null> {
    const userId = await this.authenticateUser(token);
    if (!userId) {
      this.sendJson(client, { type: 'error', message: 'Token inválido' });
      client.close();
      return null;
    }

    if (!this.checkRateLimit(userId)) {
      this.sendJson(client, {
        type: 'error',
        message: `Límite de conversaciones de soporte alcanzado (máximo ${this.MAX_CALLS_PER_HOUR} por hora)`,
      });
      client.close();
      return null;
    }

    if (this.sessions.size >= this.MAX_CONCURRENT) {
      this.sendJson(client, {
        type: 'error',
        message:
          'Demasiadas conversaciones activas. Inténtalo en unos minutos.',
      });
      client.close();
      return null;
    }

    const config = await this.supportChatService.getConfig();
    if (!config.enabled) {
      this.sendJson(client, {
        type: 'error',
        message: 'El asistente de soporte no está disponible en este momento',
      });
      client.close();
      return null;
    }

    const existingSessionId = this.userSessions.get(userId);
    if (existingSessionId) {
      this.endSession(existingSessionId, 'replaced');
    }

    const knowledgeSourceIds = await this.supportChatService.getSourceIds();

    const sessionId = `support_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const session: SupportVoiceSession = {
      sessionId,
      userId,
      client,
      config,
      readyForAudio: false,
      queuedAudio: [],
      history: [],
      knowledgeSourceIds,
      agentSpeaking: false,
      interrupted: false,
      allowInterruptions: true,
      greetingSent: false,
      greetingPlaybackDone: false,
      createdAt: now,
      pendingTranscript: '',
      llmProcessing: false,
    };

    this.sessions.set(sessionId, session);
    this.userSessions.set(userId, sessionId);
    this.clientToSession.set(client, sessionId);

    this.incrementRateLimit(userId);

    session.sessionTimeout = setTimeout(() => {
      this.logger.log(
        `⏱️ [SupportVoice] Sesión ${sessionId} expirada por tiempo`,
      );
      this.endSession(sessionId, 'timeout');
    }, this.MAX_SESSION_MS);

    this.logger.log(
      `💬 [SupportVoice] Sesión ${sessionId} creada para ${userId} (voice, lang: ${config.language ?? 'es'})`,
    );

    this.connectDeepgramSTT(session);
    this.sendJson(client, { type: 'session.ready', sessionId });

    return sessionId;
  }

  private async authenticateUser(token: string): Promise<string | null> {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      return decoded.uid;
    } catch {
      return null;
    }
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(userId);
    if (!entry || now - entry.windowStart > this.RATE_LIMIT_WINDOW_MS) {
      return true;
    }
    return entry.count < this.MAX_CALLS_PER_HOUR;
  }

  private incrementRateLimit(userId: string): void {
    const now = Date.now();
    const entry = this.rateLimits.get(userId);
    if (!entry || now - entry.windowStart > this.RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(userId, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }
  }

  // ── Deepgram STT ──────────────────────────────────────────────────────────

  private connectDeepgramSTT(session: SupportVoiceSession): void {
    if (!this.deepgramApiKey) {
      this.logger.error(
        '❌ [SupportVoice] DG_VOICE_AGENT_API_KEY no configurado',
      );
      this.endSession(session.sessionId, 'error');
      return;
    }

    const ws = new WebSocket(this.deepgramUrl, {
      headers: {
        Authorization: `Token ${this.deepgramApiKey}`,
        'User-Agent': 'llamalo-ai/support-voice',
      },
    });

    session.deepgramSocket = ws;

    ws.on('open', () => {
      this.logger.log(
        `🔌 [SupportVoice] Deepgram STT conectado para ${session.sessionId}`,
      );
      this.sendDeepgramSettings(session);
      this.startKeepAlive(session);
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.handleDeepgramMessage(session, data, isBinary);
    });

    ws.on('close', (code) => {
      session.readyForAudio = false;
      this.stopKeepAlive(session);
      if (code !== 1000 && code !== 1001) {
        this.logger.warn(
          `⚠️ [SupportVoice] Deepgram cerrado inesperadamente (${code})`,
        );
      }
    });

    ws.on('error', (error) => {
      this.logger.error(`❌ [SupportVoice] Error Deepgram: ${error.message}`);
      this.endSession(session.sessionId, 'error');
    });
  }

  private sendDeepgramSettings(session: SupportVoiceSession): void {
    const language = session.config.language || 'es';
    const payload = {
      type: 'Settings',
      audio: {
        input: { encoding: 'linear16', sample_rate: 16000 },
        output: {
          encoding: 'linear16',
          sample_rate: 16000,
          container: 'none',
        },
      },
      agent: {
        language,
        listen: {
          provider: {
            type: 'deepgram',
            model: this.deepgramListenModel,
            language,
            smart_format: true,
          },
        },
      },
    };

    const socket = session.deepgramSocket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  private handleDeepgramMessage(
    session: SupportVoiceSession,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) return;

    try {
      const raw = this.rawDataToString(data);
      const message = JSON.parse(raw) as Record<string, unknown>;
      const type = message.type as string;
      if (!type) return;

      switch (type) {
        case 'SettingsApplied':
          session.readyForAudio = true;
          this.flushQueuedAudio(session);
          this.maybeSendGreeting(session);
          break;

        case 'UserStartedSpeaking':
          if (session.agentSpeaking && session.allowInterruptions) {
            this.logger.log(`🛑 [SupportVoice] Interrupción detectada (Barge-in), silenciando agente`);
            session.interrupted = true;
            session.agentSpeaking = false;
            
            if (session.ttsCancelStream) {
              session.ttsCancelStream();
              session.ttsCancelStream = undefined;
            }
            session.currentTTSRequest = undefined;

            // Enviar instrucción al frontend para que vacíe su buffer de audio inmediatamente
            this.sendJson(session.client, { type: 'clear_audio' });
          }
          break;

        case 'ConversationText': {
          const role = this.extractRole(message);
          const text = this.extractText(message);

          if (text && role === 'user') {
            this.logger.log(
              `📝 [SupportVoice] Transcript usuario: "${text.substring(0, 80)}"`,
            );
            this.sendJson(session.client, {
              type: 'transcript',
              role: 'user',
              text,
            });
            this.enqueueTranscript(session, text);
          }
          break;
        }

        case 'Welcome':
        case 'AgentStartedSpeaking':
        case 'AgentAudioDone':
        case 'AgentThinking':
        case 'History':
          break;

        case 'Error': {
          const errDesc =
            typeof message.description === 'string' ? message.description : '';
          this.logger.error(`❌ [SupportVoice] Deepgram error: ${errDesc}`);
          break;
        }
      }
    } catch (error) {
      this.logger.error(
        '❌ [SupportVoice] Error parsing Deepgram message:',
        error,
      );
    }
  }

  // ── Audio forwarding ──────────────────────────────────────────────────────

  private forwardAudioToDeepgram(sessionId: string, chunk: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.readyForAudio) {
      session.queuedAudio.push(chunk);
      if (session.queuedAudio.length > this.MAX_BUFFERED_CHUNKS) {
        session.queuedAudio.shift();
      }
      return;
    }

    const socket = session.deepgramSocket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(chunk, { binary: true });
      } catch (err) {
        this.logger.error(
          `❌ [SupportVoice] Error enviando audio a Deepgram:`,
          err,
        );
      }
    }
  }

  private flushQueuedAudio(session: SupportVoiceSession): void {
    if (!session.queuedAudio.length) return;
    const buffered = [...session.queuedAudio];
    session.queuedAudio.length = 0;

    const socket = session.deepgramSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    for (const chunk of buffered) {
      try {
        socket.send(chunk, { binary: true });
      } catch {
        break;
      }
    }
  }

  // ── Debounce de transcripciones ─────────────────────────────────────────

  private enqueueTranscript(session: SupportVoiceSession, text: string): void {
    session.pendingTranscript += (session.pendingTranscript ? ' ' : '') + text;

    if (session.transcriptDebounceTimer) {
      clearTimeout(session.transcriptDebounceTimer);
    }

    session.transcriptDebounceTimer = setTimeout(() => {
      session.transcriptDebounceTimer = undefined;
      const fullText = session.pendingTranscript.trim();
      session.pendingTranscript = '';

      if (fullText) {
        void this.handleFinalTranscript(session, fullText);
      }
    }, this.TRANSCRIPT_DEBOUNCE_MS);
  }

  // ── LLM ────────────────────────────────────────────────────────────────────

  private async handleFinalTranscript(
    session: SupportVoiceSession,
    text: string,
  ): Promise<void> {
    if (session.llmProcessing) {
      session.pendingTranscript +=
        (session.pendingTranscript ? ' ' : '') + text;
      return;
    }

    session.llmProcessing = true;

    // Si el usuario habla, forzamos la interrupción del audio que esté sonando
    session.interrupted = true;
    session.agentSpeaking = false;
    
    if (session.ttsCancelStream) {
      session.ttsCancelStream();
      session.ttsCancelStream = undefined;
    }
    session.currentTTSRequest = undefined;
    this.sendJson(session.client, { type: 'clear_audio' });

    // Ahora empezamos a procesar el nuevo mensaje
    session.interrupted = false;

    session.history.push({ role: 'user', content: text });

    try {
      this.logger.log(`🤖 [SupportVoice] Construyendo prompt para: "${text}"`);
      const systemPrompt = await this.buildSystemPrompt(session, text);

      this.sendJson(session.client, { type: 'agent.thinking' });
      this.logger.log(`🤖 [SupportVoice] Llamando a OpenAI en modo stream...`);

      const stream = await this.openai.chat.completions.create({
        model: session.config.model ?? 'gpt-4o-mini',
        temperature: 0.2, // Bajamos la temperatura para respuestas más rápidas y directas
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          ...session.history,
        ],
        stream: true,
      });

      session.agentSpeaking = true;
      session.interrupted = false;
      session.allowInterruptions = true;
      this.sendJson(session.client, { type: 'agent.speaking' });

      let fullResponse = '';
      let sentenceBuffer = '';
      const sentenceEnders = new Set(['.', '!', '?', '\n']); // Caracteres de fin de frase
      const pauseEnders = new Set([',', ':', ';']); // Pausas menores

      let ttsQueue = Promise.resolve();
      let firstChunkReceived = false;

      for await (const chunk of stream) {
        if (session.interrupted) {
          this.logger.log(`🛑 [SupportVoice] Generación LLM interrumpida por el usuario.`);
          break;
        }

        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          fullResponse += token;
          sentenceBuffer += token;

          // Enviar el texto completo al frontend progresivamente (para el chat visual)
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            this.sendJson(session.client, {
              type: 'transcript.start',
              role: 'assistant',
            });
          }
          this.sendJson(session.client, {
            type: 'transcript.delta',
            text: token,
          });

          // Lógica de chunking para el TTS
          const lastChar = token.slice(-1);
          const isSentenceEnd = sentenceEnders.has(lastChar);
          const isPauseEnd = pauseEnders.has(lastChar) && sentenceBuffer.split(' ').length > 8;

          if (isSentenceEnd || isPauseEnd) {
            const sentenceToSend = sentenceBuffer.trim();
            if (sentenceToSend) {
              const currentSentence = sentenceToSend;
              ttsQueue = ttsQueue.then(async () => {
                if (!session.interrupted) {
                  await this.streamTTSFromText(session, currentSentence);
                }
              });
            }
            sentenceBuffer = '';
          }
        }
      }

      // Enviar cualquier texto sobrante al TTS
      if (!session.interrupted && sentenceBuffer.trim()) {
        const remainingText = sentenceBuffer.trim();
        ttsQueue = ttsQueue.then(async () => {
          if (!session.interrupted) {
            await this.streamTTSFromText(session, remainingText);
          }
        });
      }

      // Esperar a que el audio termine
      await ttsQueue;

      // Finalizar el mensaje en el frontend
      if (fullResponse.trim()) {
        session.history.push({ role: 'assistant', content: fullResponse.trim() });
        this.sendJson(session.client, {
          type: 'transcript',
          role: 'assistant',
          text: fullResponse.trim(),
          isFinal: true
        });
      }
    } catch (err) {
      this.logger.error(`❌ [SupportVoice] Error LLM:`, err);
      this.sendJson(session.client, {
        type: 'error',
        message: 'Hubo un error procesando tu mensaje. Intenta de nuevo.',
      });
    } finally {
      session.llmProcessing = false;

      const queued = session.pendingTranscript.trim();
      if (queued) {
        session.pendingTranscript = '';
        void this.handleFinalTranscript(session, queued);
      }
    }
  }

  /**
   * Helper para leer archivos estáticos (prompts, conocimiento).
   * Devuelve string vacío si el archivo no existe o hay error.
   */
  private readStaticFile(filePath: string): string {
    try {
      const absolutePath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(absolutePath)) {
        return fs.readFileSync(absolutePath, 'utf8');
      }
      return '';
    } catch (error) {
      this.logger.warn(`⚠️ Error leyendo archivo estático ${filePath}: ${error}`);
      return '';
    }
  }

  private async buildSystemPrompt(
    session: SupportVoiceSession,
    userQuery: string,
  ): Promise<string> {
    let prompt = session.config.agentInstruction;

    // Inyectar reglas de voz
    const voiceRules = this.readStaticFile('src/prompts/voice-rules.md');
    if (voiceRules) {
      prompt += `\n\n${voiceRules}`;
    }

    if (session.knowledgeSourceIds.length > 0) {
      try {
        const searchResults = await this.supportChatService.searchKnowledge(
          userQuery,
          5,
        );

        if (searchResults.results?.length > 0) {
          const context = searchResults.results
            .map(
              (r: { sourceName: string; content: string }) =>
                `[${r.sourceName}]: ${r.content}`,
            )
            .join('\n\n');

          prompt += `\n\n--- DOCUMENTACIÓN DE REFERENCIA ---\n${context}\n--- FIN DOCUMENTACIÓN ---`;
        }
      } catch (err) {
        this.logger.warn(`Error buscando en KB: ${err}`);
      }
    }

    if (session.config.contactEmail) {
      prompt += `\n\nSi el usuario necesita hablar con un humano, proporciona este contacto: Email: ${session.config.contactEmail}`;
    }

    return prompt;
  }

  // ── TTS ────────────────────────────────────────────────────────────────────

  private async streamTTSFromText(
    session: SupportVoiceSession,
    text: string,
  ): Promise<void> {
    if (session.interrupted || !text.trim()) return;

    if (session.currentTTSRequest) {
      try {
        await session.currentTTSRequest;
      } catch {
        /* ignorar */
      }
    }

    const wasGreeting = !session.greetingPlaybackDone;
    if (wasGreeting) {
      session.allowInterruptions = false;
    }
    session.interrupted = false;

    session.currentTTSRequest = this.streamElevenLabsTTS(session, text)
      .catch((err) => {
        if (!session.interrupted) {
          this.logger.error(`❌ [SupportVoice] Error TTS:`, err);
        }
      })
      .finally(() => {
        session.currentTTSRequest = undefined;
        if (wasGreeting) {
          session.allowInterruptions = true;
          session.greetingPlaybackDone = true;
        }
        session.agentSpeaking = false;
        this.sendJson(session.client, { type: 'agent.done' });
      });

    await session.currentTTSRequest;
  }

  private async streamElevenLabsTTS(
    session: SupportVoiceSession,
    text: string,
  ): Promise<void> {
    if (!this.elevenLabsApiKey) {
      this.logger.error(`❌ [SupportVoice] ELEVENLABS_API_KEY no configurado`);
      return;
    }

    const voiceId = session.config.voiceId || this.defaultVoiceId;
    const params = session.config.parameters;
    const url = `${this.elevenLabsBaseUrl}/text-to-speech/${voiceId}/stream?output_format=${this.ttsOutputFormat}&optimize_streaming_latency=3`;

    session.agentSpeaking = true;

    const response = await axios.post(
      url,
      {
        text: text.trim(),
        model_id: this.elevenLabsTtsModelId,
        voice_settings: {
          stability: params?.stability ?? this.defaultStability,
          similarity_boost: params?.similarity ?? this.defaultSimilarity,
          style: params?.style ?? this.defaultStyle,
          use_speaker_boost: params?.boost ?? this.defaultBoost,
          voice_speed: params?.speed ?? this.defaultSpeed,
        },
        output_format: this.ttsOutputFormat,
      },
      {
        headers: {
          'xi-api-key': this.elevenLabsApiKey,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 10000,
        validateStatus: (status) => status < 500,
      },
    );

    if (response.status >= 400) {
      const chunks: Buffer[] = [];
      for await (const chunk of response.data as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const errorBody = Buffer.concat(chunks).toString('utf-8');
      throw new Error(`ElevenLabs TTS error ${response.status}: ${errorBody}`);
    }

    const audioStream = response.data as Readable;
    audioStream.resume();

    const cancel = () => {
      session.agentSpeaking = false;
      audioStream.destroy();
    };
    session.ttsCancelStream = cancel;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cancel();
        reject(new Error('TTS timeout'));
      }, 30000);

      audioStream.on('data', (chunk: Buffer) => {
        if (session.allowInterruptions !== false && session.interrupted) {
          clearTimeout(timeout);
          cancel();
          return;
        }

        try {
          session.client.send(Buffer.from(chunk));
        } catch (err) {
          this.logger.error(
            `❌ [SupportVoice] Error enviando audio al cliente:`,
            err,
          );
        }
      });

      audioStream.on('end', () => {
        clearTimeout(timeout);
        session.ttsCancelStream = undefined;
        resolve();
      });

      audioStream.on('close', () => {
        clearTimeout(timeout);
        session.ttsCancelStream = undefined;
        resolve();
      });

      audioStream.on('error', (err) => {
        clearTimeout(timeout);
        session.ttsCancelStream = undefined;
        reject(err);
      });
    });
  }

  // ── Greeting ───────────────────────────────────────────────────────────────

  private maybeSendGreeting(session: SupportVoiceSession): void {
    if (session.greetingSent || !session.config.firstInteraction?.trim())
      return;

    session.greetingSent = true;
    const greeting = session.config.firstInteraction.trim().slice(0, 500);

    // No metemos el saludo en el historial para evitar bucles o repeticiones extrañas
    // session.history.push({ role: 'assistant', content: greeting });

    session.agentSpeaking = true;
    session.allowInterruptions = true; // Permitir que el usuario corte el saludo inicial

    this.sendJson(session.client, {
      type: 'transcript',
      role: 'assistant',
      text: greeting,
      isFinal: true
    });
    this.sendJson(session.client, { type: 'agent.speaking' });

    void this.streamTTSFromText(session, greeting).catch((err) => {
      this.logger.error(`❌ [SupportVoice] Error en greeting TTS:`, err);
      session.greetingSent = false;
    });
  }

  // ── Gestión de sesión ─────────────────────────────────────────────────────

  private endSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.log(
      `🔚 [SupportVoice] Sesión ${sessionId} terminada (${reason})`,
    );

    try {
      this.sendJson(session.client, { type: 'session.ended', reason });
    } catch {
      /* ignorar */
    }

    this.cleanupSession(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.transcriptDebounceTimer) {
      clearTimeout(session.transcriptDebounceTimer);
    }

    if (session.sessionTimeout) {
      clearTimeout(session.sessionTimeout);
    }

    this.stopKeepAlive(session);

    if (session.ttsCancelStream) {
      session.ttsCancelStream();
    }

    if (
      session.deepgramSocket &&
      session.deepgramSocket.readyState === WebSocket.OPEN
    ) {
      session.deepgramSocket.close();
    }

    this.clientToSession.delete(session.client);
    this.userSessions.delete(session.userId);
    this.sessions.delete(sessionId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sendJson(
    client: SupportChatClient,
    data: Record<string, unknown>,
  ): void {
    try {
      client.send(JSON.stringify(data));
    } catch {
      /* ignorar */
    }
  }

  private extractText(message: Record<string, unknown>): string {
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (typeof message.message === 'string') return message.message;
    if (message.data && typeof message.data === 'object') {
      const data = message.data as Record<string, unknown>;
      if (typeof data.text === 'string') return data.text;
      if (typeof data.content === 'string') return data.content;
    }
    return '';
  }

  private extractRole(message: Record<string, unknown>): string | null {
    if (typeof message.role === 'string') return message.role.toLowerCase();
    if (typeof message.speaker === 'string')
      return message.speaker.toLowerCase();
    if (message.data && typeof message.data === 'object') {
      const data = message.data as Record<string, unknown>;
      if (typeof data.role === 'string') return data.role.toLowerCase();
    }
    return null;
  }

  private rawDataToString(data: RawData): string {
    if (typeof data === 'string') return data;
    if (data instanceof Buffer) return data.toString();
    if (Array.isArray(data)) return Buffer.concat(data).toString();
    return Buffer.from(data as ArrayBuffer).toString();
  }

  private startKeepAlive(session: SupportVoiceSession): void {
    this.stopKeepAlive(session);
    session.keepAliveTimer = setInterval(() => {
      const socket = session.deepgramSocket;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch {
          /* ignorar */
        }
      }
    }, this.KEEPALIVE_MS);
  }

  private stopKeepAlive(session: SupportVoiceSession): void {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = undefined;
    }
  }
}
