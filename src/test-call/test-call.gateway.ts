import { Injectable } from '@nestjs/common';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import {
  ShopifyService,
  NormalizedStore,
  NormalizedProduct,
  NormalizedOrder,
} from '../shopify/shopify.service';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestCallConfig {
  agentInstruction: string;
  firstInteraction?: string;
  language: string;
  name?: string;
  voiceId: string;
  parameters?: {
    stability?: number;
    similarity?: number;
    style?: number;
    boost?: boolean;
    speed?: number;
  };
  shopifyDomain?: string;
}

type Role = 'user' | 'assistant' | 'system';
type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'system'; content: string };

export interface TestCallWebSocketClient {
  send: (data: string | Buffer) => void;
  close: () => void;
}

interface ShopifyContext {
  shopDomain: string;
  store?: NormalizedStore;
  featuredProducts?: NormalizedProduct[];
  orders?: NormalizedOrder[];
}

interface TestCallSession {
  sessionId: string;
  userId: string;
  client: TestCallWebSocketClient;
  config: TestCallConfig;
  deepgramSocket?: WebSocket;
  readyForAudio: boolean;
  queuedAudio: Buffer[];
  history: Message[];
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
  shopifyContext?: ShopifyContext;
  // Debounce de transcripciones para agrupar fragmentos de una misma frase
  pendingTranscript: string;
  transcriptDebounceTimer?: NodeJS.Timeout;
  // Lock para evitar llamadas LLM concurrentes
  llmProcessing: boolean;
  expectedAudioEndTime?: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

type IncomingMessage =
  | { type: 'session.start'; token: string; config: TestCallConfig }
  | { type: 'audio'; data: string }
  | { type: 'session.end' };

// ── Gateway ──────────────────────────────────────────────────────────────────

@Injectable()
export class TestCallGateway {
  private sessions = new Map<string, TestCallSession>();
  private rateLimits = new Map<string, RateLimitEntry>();
  private userSessions = new Map<string, string>();
  private clientToSession = new Map<TestCallWebSocketClient, string>();

  // Límites
  private readonly MAX_SESSION_MS = 2 * 60 * 1000;
  private readonly MAX_CALLS_PER_HOUR = 100000; // Incrementado drásticamente para pruebas sin límites
  private readonly MAX_CONCURRENT = 50; // Aumentado para soportar múltiples pruebas simultáneas
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  private readonly KEEPALIVE_MS = 15_000;
  private readonly MAX_BUFFERED_CHUNKS = 25;

  // ElevenLabs
  private readonly elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  private readonly elevenLabsBaseUrl =
    process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1';
  private readonly elevenLabsTtsModelId =
    process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_flash_v2_5';
  private readonly defaultVoiceId =
    process.env.ELEVENLABS_TTS_VOICE_ID ?? '15bJsujCI3tcDWeoZsQP';
  private readonly defaultStability = Number(
    process.env.ELEVENLABS_TTS_STABILITY ?? 0.72,
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

  // Deepgram (solo STT)
  private readonly deepgramApiKey =
    process.env.DG_VOICE_AGENT_API_KEY ?? process.env.DG_API_KEY;
  private readonly deepgramUrl =
    process.env.DG_VOICE_AGENT_URL ||
    'wss://agent.deepgram.com/v1/agent/converse';
  private readonly deepgramListenModel =
    process.env.DG_LISTEN_MODEL ?? 'nova-3';

  // OpenAI
  private readonly llmModel = process.env.OPENAI_MODEL ?? 'gpt-4o';
  private readonly llmTemperature = Number(
    process.env.OPENAI_TEMPERATURE ?? 0.4,
  );
  private readonly llmMaxTokens = Number(process.env.OPENAI_MAX_TOKENS ?? 200);
  private readonly openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // PCM 16-bit 16kHz para el navegador
  private readonly ttsOutputFormat = 'pcm_16000';

  constructor(private readonly shopifyService: ShopifyService) {}

  // ── Conexión WebSocket ─────────────────────────────────────────────────────

  handleConnection(
    client: TestCallWebSocketClient,
    onMessage: (handler: (raw: Buffer) => void) => void,
  ) {
    console.log('🧪 [TestCall] Nueva conexión WebSocket');
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
              const result = await this.startSession(
                client,
                msg.token,
                msg.config,
              );
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
          console.error('❌ [TestCall] Error procesando mensaje:', err);
        }
      })();
    });
  }

  handleDisconnect(client: TestCallWebSocketClient) {
    const sessionId = this.clientToSession.get(client);
    if (sessionId) {
      this.endSession(sessionId, 'disconnect');
    }
  }

  // ── Inicio de sesión ──────────────────────────────────────────────────────

  private async startSession(
    client: TestCallWebSocketClient,
    token: string,
    config: TestCallConfig,
  ): Promise<string | null> {
    const userId = await this.authenticateUser(token);
    if (!userId) {
      this.sendJson(client, {
        type: 'error',
        message: 'Token inválido o expirado',
      });
      client.close();
      return null;
    }

    if (!this.checkRateLimit(userId)) {
      this.sendJson(client, {
        type: 'error',
        message: `Límite de pruebas alcanzado (máximo ${this.MAX_CALLS_PER_HOUR} por hora)`,
      });
      client.close();
      return null;
    }

    if (this.sessions.size >= this.MAX_CONCURRENT) {
      this.sendJson(client, {
        type: 'error',
        message:
          'Demasiadas sesiones de prueba activas. Inténtalo en unos minutos.',
      });
      client.close();
      return null;
    }

    const existingSessionId = this.userSessions.get(userId);
    if (existingSessionId) {
      this.endSession(existingSessionId, 'replaced');
    }

    const sessionId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: TestCallSession = {
      sessionId,
      userId,
      client,
      config,
      readyForAudio: false,
      queuedAudio: [],
      history: [],
      agentSpeaking: false,
      interrupted: false,
      allowInterruptions: true,
      greetingSent: false,
      greetingPlaybackDone: false,
      createdAt: Date.now(),
      shopifyContext: config.shopifyDomain
        ? { shopDomain: config.shopifyDomain }
        : undefined,
      pendingTranscript: '',
      llmProcessing: false,
    };

    this.sessions.set(sessionId, session);
    this.userSessions.set(userId, sessionId);
    this.clientToSession.set(client, sessionId);

    session.sessionTimeout = setTimeout(() => {
      console.log(`⏱️ [TestCall] Sesión ${sessionId} expirada por timeout`);
      this.endSession(sessionId, 'timeout');
    }, this.MAX_SESSION_MS);

    this.incrementRateLimit(userId);

    console.log(
      `🧪 [TestCall] Sesión ${sessionId} creada para usuario ${userId} (voice: ${config.voiceId}, lang: ${config.language})`,
    );

    this.connectDeepgramSTT(session);

    if (session.shopifyContext && userId) {
      void this.loadShopifyContext(session).catch((err) => {
        console.warn(
          `⚠️ [TestCall] Error cargando Shopify:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    this.sendJson(client, { type: 'session.ready', sessionId });
    return sessionId;
  }

  // ── Autenticación ─────────────────────────────────────────────────────────

  private async authenticateUser(token: string): Promise<string | null> {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      return decoded.uid;
    } catch {
      return null;
    }
  }

  // ── Rate Limiting ─────────────────────────────────────────────────────────

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

  private connectDeepgramSTT(session: TestCallSession): void {
    if (!this.deepgramApiKey) {
      console.error('❌ [TestCall] DG_VOICE_AGENT_API_KEY no configurado');
      this.endSession(session.sessionId, 'error');
      return;
    }

    const ws = new WebSocket(this.deepgramUrl, {
      headers: {
        Authorization: `Token ${this.deepgramApiKey}`,
        'User-Agent': 'llamalo-ai/test-call',
      },
    });

    session.deepgramSocket = ws;

    ws.on('open', () => {
      console.log(
        `🔌 [TestCall] Deepgram STT conectado para ${session.sessionId}`,
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
        console.warn(
          `⚠️ [TestCall] Deepgram cerrado inesperadamente (${code})`,
        );
      }
    });

    ws.on('error', (error) => {
      console.error(`❌ [TestCall] Error Deepgram:`, error.message);
      this.endSession(session.sessionId, 'error');
    });
  }

  private sendDeepgramSettings(session: TestCallSession): void {
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
            endpointing: 300,
            interim_results: true,
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
    session: TestCallSession,
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
          // Delegamos la interrupción a ConversationText parcial para evitar falsos positivos
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
          // console.log(`⏳ [TestCall] VAD Semántico: Usuario parece no haber terminado ("...${lastWord}")`);
        }

        console.log(
          `📝 [TestCall] [USER_TEXT] Transcript usuario: "${text.substring(0, 80)}"`,
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
                console.log(`🛑 [TestCall] Usuario interrumpió al agente (parcial: "${text.substring(0, 30)}...")`);
                session.interrupted = true;
                session.agentSpeaking = false;
                session.expectedAudioEndTime = 0;
                
                if (session.ttsCancelStream) {
                  session.ttsCancelStream();
                  session.ttsCancelStream = undefined;
                }
                session.currentTTSRequest = undefined;
                
                // Vaciar buffer del frontend
                this.sendJson(session.client, { type: 'clear_audio' });
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
          console.error(`❌ [TestCall] Deepgram error: ${errDesc}`);
          break;
        }
      }
    } catch (error) {
      console.error(`❌ [TestCall] Error parsing Deepgram message:`, error);
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
        console.error(`❌ [TestCall] Error enviando audio a Deepgram:`, err);
      }
    }
  }

  private flushQueuedAudio(session: TestCallSession): void {
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

  private readonly TRANSCRIPT_DEBOUNCE_MS = 400;

  private enqueueTranscript(session: TestCallSession, text: string): void {
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
    session: TestCallSession,
    text: string,
  ): Promise<void> {
    if (session.llmProcessing) {
      console.log(
        `⏳ [TestCall] LLM ocupado, encolando: "${text.substring(0, 60)}"`,
      );
      session.pendingTranscript +=
        (session.pendingTranscript ? ' ' : '') + text;
      return;
    }

    session.llmProcessing = true;

    if (session.interrupted) {
      session.interrupted = false;
      session.agentSpeaking = false;
    }

    session.history.push({ role: 'user', content: text });
    this.sendJson(session.client, { type: 'agent.thinking' });

    // --- MULETILLAS (Comfort Noise Verbal) ---
    if (text.split(' ').length > 3 && Math.random() < 0.35) {
      const fillers = ['Mmm...', 'Vale,', 'A ver...', 'Entiendo,', 'Déjame ver...', 'Claro,'];
      const randomFiller = fillers[Math.floor(Math.random() * fillers.length)];
      console.log(`🗣️ [TestCall] Muletilla: "${randomFiller}"`);
      session.currentTTSRequest = this.streamElevenLabsTTS(session, randomFiller).catch(() => {});
    }

    try {
      const instructions = this.buildInstructions(session);

      this.sendJson(session.client, { type: 'agent.thinking' });

      const completion = await this.openai.chat.completions.create({
        model: this.llmModel,
        temperature: this.llmTemperature,
        max_tokens: this.llmMaxTokens,
        messages: [
          { role: 'system', content: instructions },
          ...session.history,
        ],
      });

      const rawContent = completion.choices[0]?.message?.content?.trim() || '';
      if (!rawContent) return;

      console.log(`🤖 [TestCall] [AGENT_RESPONSE] Respuesta final: "${rawContent}"`);

      // Si había una muletilla, esperamos a que termine antes de mandar la respuesta principal
      if (session.currentTTSRequest) {
        try { await session.currentTTSRequest; } catch (e) {}
      }

      const shouldHangup = this.containsEndCallSignal(rawContent);
      const content = this.stripEndCallToken(rawContent);

      if (shouldHangup) {
        console.log(
          `🔚 [TestCall] Señal [END_CALL] detectada en respuesta del agente. Se cerrará la sesión tras el TTS.`,
        );
      }

      if (!content) {
        if (shouldHangup) {
          this.endSession(session.sessionId, 'agent_hangup');
        }
        return;
      }

      session.history.push({ role: 'assistant', content });
      console.log(`💬 [TestCall] Respuesta LLM: "${content.substring(0, 80)}"`);

      this.sendJson(session.client, {
        type: 'transcript',
        role: 'assistant',
        text: content,
      });

      session.agentSpeaking = true;
      session.interrupted = false;
      session.allowInterruptions = true;

      this.sendJson(session.client, { type: 'agent.speaking' });

      console.log(`🤖 [TestCall] [AGENT_TEXT] Generando: "${content}"`);
      await this.streamTTSFromText(session, content);

      if (shouldHangup && !session.interrupted) {
        console.log(
          `🔚 [TestCall] Cerrando sesión ${session.sessionId} por señal del agente (agent_hangup).`,
        );
        this.endSession(session.sessionId, 'agent_hangup');
        return;
      }
    } catch (err) {
      console.error(`❌ [TestCall] Error LLM:`, err);
    } finally {
      session.llmProcessing = false;

      const queued = session.pendingTranscript.trim();
      if (queued && this.sessions.has(session.sessionId)) {
        session.pendingTranscript = '';
        console.log(
          `🔄 [TestCall] Procesando texto encolado: "${queued.substring(0, 60)}"`,
        );
        void this.handleFinalTranscript(session, queued);
      }
    }
  }

  /**
   * Limpia el token técnico `[END_CALL]` y cualquier variante vocalizable
   * («End Call», «END CALL», «end_call», «end-call», «endcall», con o sin
   * corchetes o espacios) que el agente pueda emitir al cerrar la
   * conversación. Evita que el TTS lo pronuncie y que aparezca en el chat.
   */
  private stripEndCallToken(text: string): string {
    if (!text) return text;
    return text
      .replace(/\[?\s*END[\s_\-]*CALL\s*\]?/gi, '')
      .replace(/^[\s\[\]]+|[\s\[\]]+$/g, '')
      .trim();
  }

  /** Detecta si un fragmento de texto contiene el token `[END_CALL]` o variantes vocales. */
  private containsEndCallSignal(text: string): boolean {
    if (!text) return false;
    return /\[?\s*END[\s_\-]*CALL\s*\]?/i.test(text);
  }

  private buildInstructions(session: TestCallSession): string {
    let instructions = session.config.agentInstruction;

    // 0. Limpieza proactiva: Si no hay Shopify, eliminar rastro de la sección 7 de las instrucciones base
    const hasValidShopify =
      session.shopifyContext?.shopDomain &&
      !session.shopifyContext.shopDomain.includes('example.com');

    if (!hasValidShopify && instructions) {
      const shopifySectionRegex =
        /============================================================\s*## 7\. USO DEL CONTEXTO DE SHOPIFY[\s\S]*?(?============================================================\s*## 8\.)/i;
      if (shopifySectionRegex.test(instructions)) {
        instructions = instructions.replace(shopifySectionRegex, '');
      }
    }

    // Inyectar reglas de voz
    try {
      const voiceRulesPath = path.resolve(
        process.cwd(),
        'src/prompts/voice-rules.md',
      );
      if (fs.existsSync(voiceRulesPath)) {
        const voiceRules = fs.readFileSync(voiceRulesPath, 'utf8');
        if (voiceRules) {
          instructions += `\n\n${voiceRules}`;
        }
      }
    } catch (err) {
      console.warn('⚠️ Error al leer voice-rules.md en TestCall:', err);
    }

    if (
      session.shopifyContext?.shopDomain &&
      !session.shopifyContext.shopDomain.includes('example.com') &&
      (session.shopifyContext.store ||
        session.shopifyContext.featuredProducts?.length)
    ) {
      const shopifyData: Record<string, unknown> = {};
      if (session.shopifyContext.store) {
        shopifyData.tienda = session.shopifyContext.store;
      }
      if (session.shopifyContext.featuredProducts?.length) {
        shopifyData.productosDestacados =
          session.shopifyContext.featuredProducts;
      }
      if (session.shopifyContext.orders?.length) {
        shopifyData.pedidosRecientes = session.shopifyContext.orders;
      }

      try {
        const json = JSON.stringify(shopifyData, null, 2);
        instructions += `\n\n============================================================\n## CONTEXTO DE LA TIENDA SHOPIFY\n============================================================\n\n\`\`\`json\n${json}\n\`\`\`\n\n**Instrucciones de uso:**\n1. Para preguntas sobre PEDIDOS → Busca "pedidosRecientes"\n2. Para preguntas sobre PRODUCTOS → Busca "productosDestacados"\n3. Para preguntas sobre la TIENDA → Busca "tienda"\n4. NUNCA digas "no tengo acceso" si el dato está en este JSON\n5. SIEMPRE usa los datos reales, NO inventes información\n============================================================`;
      } catch {
        // Ignorar errores de serialización
      }
    }

    return instructions;
  }

  // ── TTS ────────────────────────────────────────────────────────────────────

  private async streamTTSFromText(
    session: TestCallSession,
    text: string,
  ): Promise<void> {
    const sanitized = this.stripEndCallToken(text);
    if (session.interrupted || !sanitized.trim()) return;
    text = sanitized;

    if (session.currentTTSRequest) {
      try {
        await session.currentTTSRequest;
      } catch {
        /* ignorar errores previos */
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
          console.error(`❌ [TestCall] Error TTS:`, err);
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
    session: TestCallSession,
    text: string,
  ): Promise<void> {
    if (!this.elevenLabsApiKey) {
      console.error(`❌ [TestCall] ELEVENLABS_API_KEY no configurado`);
      return;
    }

    const voiceId = session.config.voiceId || this.defaultVoiceId;
    const params = session.config.parameters;
    const url = `${this.elevenLabsBaseUrl}/text-to-speech/${voiceId}/stream?output_format=${this.ttsOutputFormat}`;

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
          console.error(
            `❌ [TestCall] Error enviando audio al navegador:`,
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

  private maybeSendGreeting(session: TestCallSession): void {
    if (session.greetingSent || !session.config.firstInteraction?.trim())
      return;

    session.greetingSent = true;
    const rawGreeting = session.config.firstInteraction.trim().slice(0, 500);
    const greeting = this.stripEndCallToken(rawGreeting);
    if (!greeting) {
      session.greetingSent = false;
      return;
    }

    console.log(
      `👋 [TestCall] Enviando saludo: "${greeting.substring(0, 50)}"`,
    );

    session.agentSpeaking = true;
    session.allowInterruptions = false;

    this.sendJson(session.client, {
      type: 'transcript',
      role: 'assistant',
      text: greeting,
    });
    this.sendJson(session.client, { type: 'agent.speaking' });

    void this.streamTTSFromText(session, greeting).catch((err) => {
      console.error(`❌ [TestCall] Error en greeting TTS:`, err);
      session.greetingSent = false;
    });
  }

  // ── Shopify ────────────────────────────────────────────────────────────────

  private async loadShopifyContext(session: TestCallSession): Promise<void> {
    if (!session.userId || !session.shopifyContext?.shopDomain) return;

    const { userId } = session;
    const { shopDomain } = session.shopifyContext;

    try {
      const [storeRes, productsRes, ordersRes] = (await Promise.race([
        Promise.all([
          this.shopifyService.getStoreInfo(userId, shopDomain),
          this.shopifyService.getProducts(userId, shopDomain),
          this.shopifyService.getOrders(userId, shopDomain),
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Shopify timeout')), 5000),
        ),
      ])) as [
        { store: NormalizedStore } | undefined,
        { products: NormalizedProduct[] } | undefined,
        { orders: NormalizedOrder[] } | undefined,
      ];

      if (session.shopifyContext) {
        if (storeRes?.store) session.shopifyContext.store = storeRes.store;
        if (productsRes?.products) {
          session.shopifyContext.featuredProducts = productsRes.products.slice(
            0,
            10,
          );
        }
        if (ordersRes?.orders) {
          session.shopifyContext.orders = ordersRes.orders
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 10);
        }
      }

      console.log(
        `✅ [TestCall] Contexto Shopify cargado para ${session.sessionId}`,
      );
    } catch (err) {
      console.warn(
        `⚠️ [TestCall] Error cargando Shopify (continuando sin datos):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Gestión de sesión ─────────────────────────────────────────────────────

  private endSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`🔚 [TestCall] Sesión ${sessionId} terminada (${reason})`);

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
    client: TestCallWebSocketClient,
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

  private startKeepAlive(session: TestCallSession): void {
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

  private stopKeepAlive(session: TestCallSession): void {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = undefined;
    }
  }
}
