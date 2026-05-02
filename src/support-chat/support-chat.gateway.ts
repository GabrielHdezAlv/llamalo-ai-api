import { Injectable, Logger } from '@nestjs/common';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import { SupportChatService } from './support-chat.service';
import { EmailService } from '../auth/email.service'; // Importar servicio de emails
import type { SupportAgentConfigResponseDto } from './dto/support-chat.dto';

// ── Types ────────────────────────────────────────────────────────────────────

type Role = 'user' | 'assistant' | 'system';
type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'system'; content: string };

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
  expectedAudioEndTime?: number;
  lastAgentStartSpeakingTime?: number;
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
  private readonly MAX_CALLS_PER_HOUR = 100000; // Incrementado drásticamente para pruebas sin límites
  private readonly MAX_CONCURRENT = 100; // Aumentado para soportar múltiples pruebas simultáneas
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
    'wss://agent.deepgram.com/v1/agent/converse?interim_results=true&endpointing=300';
  private readonly deepgramListenModel =
    process.env.DG_LISTEN_MODEL ?? 'nova-3';

  private readonly openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  private readonly ttsOutputFormat = 'pcm_16000';

  constructor(
    private readonly supportChatService: SupportChatService,
    private readonly emailService: EmailService,
  ) {}

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
          // Durante el saludo inicial no permitimos barge-in
          if (session.allowInterruptions === false) {
            break;
          }

          // Si el agente está hablando, interrumpimos para una sensación natural.
          // Para reducir falsos positivos (ruidos), verificamos que el agente
          // lleve hablando al menos 500ms.
          const agentSpeakingDuration = session.lastAgentStartSpeakingTime
            ? Date.now() - session.lastAgentStartSpeakingTime
            : 0;

          const isPlayingAudio =
            session.expectedAudioEndTime &&
            session.expectedAudioEndTime > Date.now();

          if (
            (session.agentSpeaking || isPlayingAudio || session.currentTTSRequest) &&
            !session.interrupted &&
            agentSpeakingDuration > 500
          ) {
            console.log(
              `🗣️ [SupportChat] Interrupción detectada por VAD (UserStartedSpeaking) - Duración agente: ${agentSpeakingDuration}ms`,
            );
            this.handleInterruption(session);
          }
          break;

        case 'ConversationText': {
          const role = this.extractRole(message);
          const text = this.extractText(message);
          const isFinal = message.is_final !== false;

          if (text && role === 'user') {
            if (isFinal) {
              // --- VAD DINÁMICO (Semántico) ---
              const unfinishedConnectors = ['y', 'o', 'pero', 'que', 'el', 'la', 'un', 'una', 'con', 'para', 'en'];
              const lastWord = text.trim().split(' ').pop()?.toLowerCase() || '';
              if (unfinishedConnectors.includes(lastWord)) {
                // console.log(`⏳ [SupportVoice] VAD Semántico: Usuario parece no haber terminado ("...${lastWord}")`);
              }

              this.logger.log(
                `📝 [SupportVoice] [USER_TEXT] Transcript usuario: "${text.substring(0, 80)}"`,
              );
              this.sendJson(session.client, {
                type: 'transcript',
                role: 'user',
                text,
              });
              this.enqueueTranscript(session, text);
            } else {
              // Parcial: verificamos interrupción
              const isPlayingAudio =
                session.expectedAudioEndTime &&
                session.expectedAudioEndTime > Date.now();

              if (
                (session.agentSpeaking || isPlayingAudio || session.currentTTSRequest) &&
                session.allowInterruptions &&
                text.trim().length > 8
              ) {
                this.logger.log(`🛑 [SupportVoice] Interrupción detectada (parcial: "${text.substring(0, 30)}...")`);
                this.handleInterruption(session);
              }
            }
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

  private handleInterruption(session: SupportVoiceSession) {
    session.interrupted = true;
    session.agentSpeaking = false;
    session.expectedAudioEndTime = 0;

    if (session.ttsCancelStream) {
      session.ttsCancelStream();
      session.ttsCancelStream = undefined;
    }
    session.currentTTSRequest = undefined;

    // Enviar instrucción al frontend para que vacíe su buffer de audio inmediatamente
    this.sendJson(session.client, { type: 'clear_audio' });
  }

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
    this.handleInterruption(session);

    // Ahora empezamos a procesar el nuevo mensaje
    session.interrupted = false;

    session.history.push({ role: 'user', content: text });
    this.sendJson(session.client, { type: 'agent.thinking' });

    // --- MULETILLAS (Comfort Noise Verbal) ---
    if (text.split(' ').length > 3 && Math.random() < 0.35) {
      const fillers = ['Mmm...', 'Vale,', 'A ver...', 'Entiendo,', 'Déjame ver...', 'Claro,'];
      const randomFiller = fillers[Math.floor(Math.random() * fillers.length)];
      this.logger.log(`🗣️ [SupportVoice] Muletilla: "${randomFiller}"`);
      session.currentTTSRequest = this.streamElevenLabsTTS(session, randomFiller).catch(() => {});
    }

    // ⚡ INTENT DETECTION LIGERO (Reducción de latencia)
    const fastIntentResponse = this.detectFastIntent(text, session);
    if (fastIntentResponse) {
      this.logger.log(
        `⚡ [SupportVoice] Intent detectado, respuesta rápida: "${fastIntentResponse}"`,
      );
      session.history.push({ role: 'assistant', content: fastIntentResponse });

      this.sendJson(session.client, {
        type: 'transcript',
        role: 'assistant',
        text: fastIntentResponse,
        isFinal: true,
      });

      session.agentSpeaking = true;
    session.lastAgentStartSpeakingTime = Date.now();
      try {
        await this.streamTTSFromText(session, fastIntentResponse);
      } catch (err) {
        this.logger.error(`❌ [SupportVoice] Error en TTS rápido:`, err);
      } finally {
        session.llmProcessing = false;
      }
      return; // Cortocircuitar el LLM
    }

    try {
      this.logger.log(`🤖 [SupportVoice] Construyendo prompt para: "${text}"`);
      const systemPrompt = await this.buildSystemPrompt(session, text);

      this.sendJson(session.client, { type: 'agent.thinking' });
      this.logger.log(`🤖 [SupportVoice] Llamando a OpenAI en modo stream...`);

      // Definir la herramienta de escalado a soporte
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'escalar_a_soporte_humano',
            description:
              'Envía un ticket o correo de soporte al equipo humano. Úsalo SOLO cuando el usuario solicite explícitamente hablar con un humano o tenga un problema técnico complejo que no puedas resolver.',
            parameters: {
              type: 'object',
              properties: {
                resumen_problema: {
                  type: 'string',
                  description:
                    'Un resumen detallado del problema que tiene el usuario, incluyendo pasos intentados si los hay.',
                },
                telefono_usuario: {
                  type: 'string',
                  description:
                    'El teléfono del usuario si te lo ha proporcionado en la llamada o chat. Si no lo sabes, pon "No proporcionado".',
                },
              },
              required: ['resumen_problema'],
            },
          },
        },
      ];

      const stream = await this.openai.chat.completions.create({
        model: session.config.model ?? 'gpt-4o',
        temperature: 0.4, // Subido a 0.4 para más expresividad/ventas
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          ...session.history,
        ],
        tools: tools,
        stream: true,
      });

      session.agentSpeaking = true;
    session.lastAgentStartSpeakingTime = Date.now();
      session.interrupted = false;
      session.allowInterruptions = true;
      this.sendJson(session.client, { type: 'agent.speaking' });

      let fullResponse = '';
      let sentenceBuffer = '';
      let functionCallName = '';
      let functionCallArgs = '';
      let shouldHangup = false;
      const sentenceEnders = new Set(['.', '!', '?', '\n']); // Caracteres de fin de frase
      const pauseEnders = new Set([',', ':', ';']); // Pausas menores

      let ttsQueue = Promise.resolve();
      let firstChunkReceived = false;

      for await (const chunk of stream) {
        if (session.interrupted) {
          this.logger.log(
            `🛑 [SupportVoice] Generación LLM interrumpida por el usuario.`,
          );
          break;
        }

        // Manejar Tool Calls (Llamadas a funciones)
        const toolCalls = chunk.choices[0]?.delta?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          const toolCall = toolCalls[0];
          if (toolCall.function?.name) {
            functionCallName = toolCall.function.name;
          }
          if (toolCall.function?.arguments) {
            functionCallArgs += toolCall.function.arguments;
          }
          continue; // Si estamos construyendo una función, no procesamos texto
        }

        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          fullResponse += token;
          sentenceBuffer += token;

          // Detectar señal técnica de colgado en el buffer acumulado (puede venir partida en varios tokens)
          if (!shouldHangup && this.containsEndCallSignal(sentenceBuffer)) {
            shouldHangup = true;
            this.logger.log(
              `🔚 [SupportVoice] Señal [END_CALL] detectada en respuesta de Xenon. Se cerrará la sesión tras finalizar el TTS.`,
            );
          }

          // Enviar el texto completo al frontend progresivamente (para el chat visual)
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            this.sendJson(session.client, {
              type: 'transcript.start',
              role: 'assistant',
            });
          }
          // Limpiar el token técnico antes de mandarlo al chat visual para que el usuario no lo vea
          const visibleToken = this.stripEndCallToken(token);
          if (visibleToken) {
            this.sendJson(session.client, {
              type: 'transcript.delta',
              text: visibleToken,
            });
          }

          // Lógica de chunking para el TTS
          const lastChar = token.slice(-1);
          const isSentenceEnd = sentenceEnders.has(lastChar);
          const isPauseEnd =
            pauseEnders.has(lastChar) && sentenceBuffer.split(' ').length > 12;

          if (isSentenceEnd || isPauseEnd) {
            // Limpiar `[END_CALL]` (y variantes vocales) antes de enviar al TTS
            const sentenceToSend = this.stripEndCallToken(sentenceBuffer);
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

      // Enviar cualquier texto sobrante al TTS (sin el token técnico)
      if (!session.interrupted && sentenceBuffer.trim()) {
        if (!shouldHangup && this.containsEndCallSignal(sentenceBuffer)) {
          shouldHangup = true;
        }
        const remainingText = this.stripEndCallToken(sentenceBuffer);
        if (remainingText) {
          ttsQueue = ttsQueue.then(async () => {
            if (!session.interrupted) {
              await this.streamTTSFromText(session, remainingText);
            }
          });
        }
      }

      // Esperar a que el audio termine
      await ttsQueue;

      // --- MANEJO DE TOOLS (LLAMADA A FUNCIONES) ---
      if (
        functionCallName === 'escalar_a_soporte_humano' &&
        !session.interrupted
      ) {
        this.logger.log(
          `📧 [SupportVoice] Ejecutando tool: ${functionCallName}`,
        );
        try {
          const args = JSON.parse(functionCallArgs);
          const { resumen_problema, telefono_usuario } = args;

          // Intentar obtener el email real del usuario desde Firestore
          let userEmail: string | undefined = undefined;
          try {
            const userDoc = await admin
              .firestore()
              .collection('users')
              .doc(session.userId)
              .get();
            if (userDoc.exists) {
              userEmail = userDoc.data()?.email;
            }
          } catch (error) {
            this.logger.warn(
              `⚠️ No se pudo obtener el email del usuario ${session.userId} desde Firestore: ${error}`,
            );
          }

          // Enviar el email
          try {
            await this.emailService.sendSupportTicket(
              session.userId,
              telefono_usuario || 'No proporcionado',
              resumen_problema,
              userEmail,
            );

            // Registrar la llamada en el historial (formato OpenAI)
            const toolCallId = `call_${Date.now()}`;
            session.history.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: functionCallName,
                    arguments: functionCallArgs,
                  },
                },
              ],
            } as any);

            session.history.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({
                success: true,
                message:
                  'Ticket enviado a soporte correctamente. El equipo humano contactará con el usuario.',
              }),
            } as any);

            // Forzamos una nueva respuesta del LLM para que confirme al usuario
            return this.handleFinalTranscript(
              session,
              '(SISTEMA: El ticket ha sido enviado con éxito. Confirma al usuario que el equipo de soporte le contactará pronto. Sé breve y profesional.)',
            );
          } catch (emailError) {
            this.logger.error(
              `❌ [SupportVoice] Error al enviar email de soporte:`,
              emailError,
            );

            // Si el email falla, informamos al LLM para que le pida al usuario escribir directamente
            return this.handleFinalTranscript(
              session,
              '(SISTEMA: Error crítico al enviar el ticket por email. Por favor, discúlpate amablemente y dile al usuario que hubo un problema técnico temporal y que debe escribir directamente a team@llamalo.ai para que le ayudemos.)',
            );
          }
        } catch (e) {
          this.logger.error(`❌ [SupportVoice] Error procesando tool call:`, e);
        }
      }

      // Finalizar el mensaje en el frontend (sin el token técnico [END_CALL])
      const cleanFullResponse = this.stripEndCallToken(fullResponse);
      if (cleanFullResponse) {
        this.logger.log(`🤖 [SupportVoice] [AGENT_RESPONSE] Respuesta final: "${cleanFullResponse}"`);
        session.history.push({
          role: 'assistant',
          content: cleanFullResponse,
        });
        this.sendJson(session.client, {
          type: 'transcript',
          role: 'assistant',
          text: cleanFullResponse,
          isFinal: true,
        });
      }

      // Si Xenon decidió cerrar la conversación, terminamos la sesión limpiamente
      // (el frontend reacciona ante `session.ended` con reason `agent_hangup`).
      if (shouldHangup && !session.interrupted) {
        this.logger.log(
          `🔚 [SupportVoice] Cerrando sesión ${session.sessionId} por señal del agente (agent_hangup).`,
        );
        this.endSession(session.sessionId, 'agent_hangup');
        return;
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
      this.logger.warn(
        `⚠️ Error leyendo archivo estático ${filePath}: ${error}`,
      );
      return '';
    }
  }

  private async buildSystemPrompt(
    session: SupportVoiceSession,
    userQuery: string,
  ): Promise<string> {
    let prompt = session.config.agentInstruction;

    // Detectar si el agente configurado es "Xenon" para inyectar su personalidad específica
    const isXenon =
      session.config.name?.toLowerCase().includes('xenon') ||
      prompt.toLowerCase().includes('xenon');

    if (isXenon) {
      this.logger.log(
        `🤖 [SupportVoice] Xenon detectado, inyectando personalidad y conocimiento base...`,
      );
      const xenonPersona = this.readStaticFile(
        'src/knowledge/llamalo-ai/xenon-persona.md',
      );
      const llamaloFeatures = this.readStaticFile(
        'src/knowledge/llamalo-ai/features.txt',
      );
      const llamaloPricing = this.readStaticFile(
        'src/knowledge/llamalo-ai/pricing.txt',
      );
      const llamaloTroubleshooting = this.readStaticFile(
        'src/knowledge/llamalo-ai/troubleshooting.txt',
      );
      const llamaloSitemap = this.readStaticFile(
        'src/knowledge/llamalo-ai/sitemap.txt',
      );

      if (xenonPersona) {
        // Reemplazar las instrucciones base por las de Xenon
        prompt = xenonPersona;
      }

      let companyKnowledge = '';
      if (llamaloFeatures)
        companyKnowledge += `\n\n--- FUNCIONALIDADES ---\n${llamaloFeatures}`;
      if (llamaloPricing)
        companyKnowledge += `\n\n--- PRECIOS ---\n${llamaloPricing}`;
      if (llamaloTroubleshooting)
        companyKnowledge += `\n\n--- TROUBLESHOOTING ---\n${llamaloTroubleshooting}`;
      if (llamaloSitemap)
        companyKnowledge += `\n\n--- GUÍA DE LA PLATAFORMA (SITEMAP) ---\n${llamaloSitemap}`;

      if (companyKnowledge) {
        prompt += `\n\n--- CONOCIMIENTO DE EMPRESA ---\nUtiliza esta información para responder a las dudas del usuario:\n${companyKnowledge}\n--- FIN CONOCIMIENTO EMPRESA ---`;
      }
    }

    // Inyectar reglas de voz estrictas
    const voiceRules = this.readStaticFile('src/prompts/voice-rules.md');
    if (voiceRules) {
      prompt += `\n\n${voiceRules}`;
    }

    // Mantener la búsqueda dinámica en KB si el usuario tiene documentos subidos
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

          prompt += `\n\n--- DOCUMENTACIÓN DE REFERENCIA ADICIONAL ---\n${context}\n--- FIN DOCUMENTACIÓN ---`;
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

  /**
   * Limpia el token técnico `[END_CALL]` y cualquier variante vocalizable
   * («End Call», «END CALL», «end_call», «endcall», con o sin corchetes) que
   * Xenon (u otros agentes) puedan emitir al cerrar la conversación. Evita
   * que el TTS pronuncie literalmente «end call» y deja sólo la despedida.
   */
  private stripEndCallToken(text: string): string {
    if (!text) return text;
    return text
      // Variante con o sin corchetes y con cualquier separador entre END y CALL
      .replace(/\[?\s*END[\s_\-]*CALL\s*\]?/gi, '')
      // Restos de un token partido en streaming, p. ej. solo "[" o "]"
      .replace(/^[\s\[\]]+|[\s\[\]]+$/g, '')
      .trim();
  }

  /** Detecta si un fragmento de texto contiene el token `[END_CALL]` o variantes vocales. */
  private containsEndCallSignal(text: string): boolean {
    if (!text) return false;
    return /\[?\s*END[\s_\-]*CALL\s*\]?/i.test(text);
  }

  private async streamTTSFromText(
    session: SupportVoiceSession,
    text: string,
  ): Promise<void> {
    const sanitized = this.stripEndCallToken(text);
    if (session.interrupted || !sanitized.trim()) return;
    text = sanitized;

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
    session.lastAgentStartSpeakingTime = Date.now();

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
          // Estimar duración del chunk en ms (8000Hz, 1 byte/muestra -> 8 bytes/ms)
          const chunkDurationMs = Math.floor(chunk.length / 8);
          const now = Date.now();
          if (
            !session.expectedAudioEndTime ||
            session.expectedAudioEndTime < now
          ) {
            session.expectedAudioEndTime = now + chunkDurationMs;
          } else {
            session.expectedAudioEndTime += chunkDurationMs;
          }
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

  /**
   * Detector de Intenciones Ligero (Intent Detection) para Xenon/Support
   * Responde frases predefinidas sin consultar al LLM
   */
  private detectFastIntent(
    text: string,
    session?: SupportVoiceSession,
  ): string | null {
    const cleanText = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Quitar tildes
      .replace(/[.,!?¡¿]/g, '')
      .trim();

    // 1. Intent: Espera / Un momento
    if (
      cleanText === 'espera' ||
      cleanText === 'espera un momento' ||
      cleanText === 'un momento' ||
      cleanText === 'aguarda' ||
      cleanText === 'esperame' ||
      cleanText === 'dame un segundo' ||
      cleanText === 'espera un rato'
    ) {
      return 'Claro, espero.';
    }

    // 2. Intent: No escucho
    if (
      cleanText === 'no te escucho' ||
      cleanText === 'no te oigo' ||
      cleanText === 'no se escucha' ||
      cleanText === 'no escucho nada' ||
      cleanText === 'se corto' ||
      cleanText === 'se escucha mal' ||
      cleanText === 'no hay audio' ||
      cleanText === 'hola estas ahi' ||
      cleanText === 'sigues ahi'
    ) {
      return 'Perdona, ¿me escuchas bien ahora?';
    }

    // 3. Intent: Repite
    if (
      cleanText === 'repite' ||
      cleanText === 'repitelo' ||
      cleanText === 'puedes repetir' ||
      cleanText === 'que dijiste' ||
      cleanText === 'como' ||
      cleanText === 'mande' ||
      cleanText === 'me lo repites' ||
      cleanText === 'no entendi' ||
      cleanText === 'como dijiste'
    ) {
      return 'Perdona, te lo repito.';
    }

    // 4. Intent: Hola / Saludo inicial redundante
    if (
      cleanText === 'hola' ||
      cleanText === 'buenas' ||
      cleanText === 'buenos dias' ||
      cleanText === 'buenas tardes' ||
      cleanText === 'buenas noches' ||
      cleanText === 'hola buenas' ||
      cleanText === 'hola hola'
    ) {
      // Si el agente ya saludó y es la primera vez que el usuario habla,
      // respondemos algo más natural para evitar el bucle de "Hola" -> "Hola"
      if (session && session.greetingSent && session.history.length <= 1) {
        return 'Sí, dime, ¿en qué puedo ayudarte?';
      }
      return '¡Hola! ¿En qué puedo ayudarte?';
    }

    return null;
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
    session.lastAgentStartSpeakingTime = Date.now();
    session.allowInterruptions = true; // Permitir que el usuario corte el saludo inicial

    this.sendJson(session.client, {
      type: 'transcript',
      role: 'assistant',
      text: greeting,
      isFinal: true,
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
