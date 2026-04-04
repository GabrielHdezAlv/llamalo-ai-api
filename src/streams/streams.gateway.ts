import { Injectable } from '@nestjs/common';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
// ffmpeg-static proporciona la ruta binaria para decodificar MP3 a PCM
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ffmpegStaticPath from 'ffmpeg-static';
import {
  NormalizedStore,
  NormalizedProduct,
  NormalizedOrder,
  NormalizedStoreResponse,
  NormalizedProductsResponse,
  ShopifyService,
} from '../shopify/shopify.service';
import { MetricsService } from '../metrics/metrics.service';
import { AgentKnowledgeService } from '../agents/agent-knowledge.service';
import { EmailService } from '../auth/email.service'; // Importar EmailService
import { SystemLogsService, LogType } from '../system-logs/system-logs.service';

type TwilioMediaIn = {
  event: 'media';
  media: {
    payload: string;
    track?: string;
    chunk?: string;
    timestamp?: string;
  };
  streamSid?: string;
};

type TwilioStart = {
  event: 'start';
  start: {
    callSid?: string;
    streamSid?: string;
    accountSid?: string;
    tracks?: string[];
    customParameters?: Record<string, unknown>;
    mediaFormat?: Record<string, unknown>;
  };
};

type TwilioStop = {
  event: 'stop';
  stop?: { accountSid?: string; callSid?: string };
};
type TwilioConnected = {
  event: 'connected';
  protocol?: string;
  version?: string;
};
type TwilioMsg = TwilioMediaIn | TwilioStart | TwilioStop | TwilioConnected;

interface WebSocketClient {
  send: (data: string) => void;
  on: (event: string, callback: (data: Buffer) => void) => void;
  close: () => void;
}

type DeepgramJsonEvent = {
  type?: string;
  [key: string]: unknown;
};

type Role = 'user' | 'assistant' | 'system';
type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'system'; content: string };

interface ShopifyContext {
  shopDomain?: string;
  store?: NormalizedStore;
  featuredProducts?: NormalizedProduct[];
  orders?: NormalizedOrder[]; // Pedidos encontrados dinámicamente
  loadedAt?: number; // timestamp para cache
}

interface CallSession {
  callSid: string;
  streamSid?: string;
  client: WebSocketClient;
  voiceAgentSocket?: WebSocket;
  sttSocket?: WebSocket;
  sttProvider: 'elevenlabs' | 'deepgram';
  customParameters?: Record<string, string>;
  instructions: string;
  voiceId?: string;
  language?: string;
  queuedAudio: Buffer[];
  outboundBuffer?: Buffer;
  readyForAudio: boolean;
  pendingGreeting?: string;
  greetingSent: boolean;
  /** Evita duplicar el saludo en session.history si el TTS dispara el .then tarde */
  initialGreetingWrittenToHistory?: boolean;
  keepAliveTimer?: NodeJS.Timeout;
  silenceTimeout?: NodeJS.Timeout; // Temporizador para detectar silencio del usuario
  deepgramRequestId?: string;
  lastAgentStartSpeakingTime?: number; // Timestamp de cuando el agente empezó a hablar la última frase
  userSpeakingStartTime?: number;
  responseLatencies: number[];
  // Conversación para el LLM
  history: Message[];
  // Estado para interceptar texto y generar TTS
  interceptedResponseText: string;
  agentSpeaking: boolean;
  interrupted: boolean;
  allowInterruptions?: boolean;
  greetingPlaybackDone?: boolean;
  /** Libera allowInterruptions tras el saludo cuando Twilio ha terminado de reproducir (evita clear en la cola). */
  pendingGreetingReleaseTimer?: NodeJS.Timeout;
  currentTTSRequest?: Promise<void>;
  ttsCancelStream?: () => void;
  // Shopify integration
  userId?: string;
  userDocument?: admin.firestore.DocumentData; // Documento completo del usuario de Firestore
  shopifyContext?: ShopifyContext;
  knowledgeSourceIds: string[];
  expectedAudioEndTime?: number;
  /** Se incrementa al hablar el usuario o al iniciar un colgado; invalida colgados en curso. */
  hangupNonce?: number;
  // Razón de finalización: 'agente' | 'cliente' | 'silencio' | 'error'
  terminadoPor?: 'agente' | 'cliente' | 'silencio' | 'error';
  callStartTime?: number; // timestamp en ms cuando comenzó la sesión
  callerPhone?: string; // número de teléfono del llamante para métricas de país
  callDirection?: 'inbound' | 'outbound';
  // Conversation Manager
  conversationState?: 'GREETING' | 'DISCOVERY' | 'SUPPORT' | 'CLOSING';
  silenceInterventions?: number;
}

@Injectable()
export class StreamsGateway {
  // Proveedor STT/TTS
  // Forzamos Deepgram como único proveedor STT; ElevenLabs se usa solo para TTS
  private readonly sttProvider = 'deepgram' as const;
  private readonly ttsProvider = process.env.TTS_PROVIDER ?? 'elevenlabs';

  // ElevenLabs
  private readonly elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  private readonly elevenLabsBaseUrl =
    process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1';
  private readonly elevenLabsSttUrl =
    process.env.ELEVENLABS_STT_URL ??
    'wss://api.elevenlabs.io/v1/speech-to-text/stream';
  private readonly elevenLabsSttModel =
    process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2';
  private readonly elevenLabsLanguage = process.env.ELEVENLABS_LANGUAGE ?? 'es';
  private readonly elevenLabsTtsVoiceId =
    process.env.ELEVENLABS_TTS_VOICE_ID ?? '15bJsujCI3tcDWeoZsQP';

  private readonly elevenLabsTtsOutputFormat = 'ulaw_8000' as const; // Solicitar mu-law nativo para passthrough directo a Twilio
  private readonly elevenLabsTtsModelId =
    process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_flash_v2_5'; // Usar Flash v2.5 para latencia ultra-baja (<100ms) en producción
  private readonly elevenLabsTtsStability = Number(
    process.env.ELEVENLABS_TTS_STABILITY ?? 0.5, // Bajado a 0.5 para mayor expresividad
  );
  private readonly elevenLabsTtsStyle = Number(
    process.env.ELEVENLABS_TTS_STYLE ?? 0.05,
  );
  private readonly elevenLabsTtsSimilarity = Number(
    process.env.ELEVENLABS_TTS_SIMILARITY ?? 0.8,
  );
  private readonly elevenLabsTtsSpeakerBoost =
    (process.env.ELEVENLABS_TTS_SPEAKER_BOOST ?? 'true') === 'true';
  private readonly elevenLabsTtsVoiceSpeed = Number(
    process.env.ELEVENLABS_TTS_VOICE_SPEED ?? 0.98,
  );

  // Deepgram (fallback)
  private readonly deepgramApiKey =
    process.env.DG_VOICE_AGENT_API_KEY ?? process.env.DG_API_KEY;
  private readonly deepgramUrl =
    process.env.DG_VOICE_AGENT_URL ||
    'wss://agent.deepgram.com/v1/agent/converse';
  private readonly deepgramLanguage =
    process.env.DG_VOICE_AGENT_LANGUAGE ?? 'es';
  private readonly deepgramListenProvider =
    process.env.DG_LISTEN_PROVIDER ?? 'deepgram';
  private readonly deepgramListenModel =
    process.env.DG_LISTEN_MODEL ?? 'nova-3';
  private readonly deepgramSpeakProvider =
    process.env.DG_SPEAK_PROVIDER ?? 'deepgram';
  private readonly deepgramSpeakModel =
    process.env.DG_SPEAK_MODEL ?? 'aura-2-nestor-es';
  private readonly thinkProvider = process.env.DG_THINK_PROVIDER;
  private readonly thinkModel = process.env.DG_THINK_MODEL;
  private readonly thinkTemperature = Number(
    process.env.DG_THINK_TEMPERATURE ?? 0.7,
  );

  // LLM
  private readonly llmModel = process.env.OPENAI_MODEL ?? 'gpt-4o';
  /** Modelo más rápido solo para el primer turno del usuario (tras el saludo), para bajar latencia inicial */
  private readonly llmModelFirstTurn =
    process.env.OPENAI_MODEL_FIRST_TURN ?? 'gpt-4o-mini';
  private readonly llmTemperature = Number(
    process.env.OPENAI_TEMPERATURE ?? 0.7, // Subido a 0.7 para respuestas de voz más creativas y conversacionales
  );
  private readonly llmMaxTokens = Number(process.env.OPENAI_MAX_TOKENS ?? 200);
  private readonly llmMaxTokensFirstTurn = Number(
    process.env.OPENAI_MAX_TOKENS_FIRST_TURN ?? 250,
  );

  // Configuración general
  private readonly keepAliveIntervalMs = Number(
    process.env.DG_KEEPALIVE_MS ?? 15_000,
  );
  private readonly maxBufferedChunks = Math.max(
    1,
    Number(process.env.DG_MAX_BUFFERED_CHUNKS ?? 25),
  );
  private readonly defaultInstructions =
    process.env.DG_AGENT_PROMPT ||
    'Eres un asistente de voz profesional y resolutivo. Responde siempre en español con frases cortas y claras.';

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  private sessions: Map<string, CallSession> = new Map();

  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly metricsService: MetricsService,
    private readonly agentKnowledgeService: AgentKnowledgeService,
    private readonly emailService: EmailService,
    private readonly systemLogsService: SystemLogsService,
  ) {
    if (!this.elevenLabsApiKey) {
      console.warn('⚠️ ELEVENLABS_API_KEY no configurado en el entorno.');
    }
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️ OPENAI_API_KEY no configurado en el entorno.');
    }
  }

  private usingElevenLabs(session?: CallSession): boolean {
    const provider = session?.sttProvider || this.sttProvider;
    return provider === 'elevenlabs';
  }

  /** Evita métricas/TTS tras cleanupSession (misma instancia de sesión ya no está en el Map). */
  private isCallSessionLive(session: CallSession): boolean {
    return this.sessions.get(session.callSid) === session;
  }

  private fileCache = new Map<string, string>();

  /**
   * Helper para leer archivos estáticos (prompts, conocimiento).
   * Devuelve string vacío si el archivo no existe o hay error.
   * OPTIMIZACIÓN: Usa cache en memoria para evitar lecturas de disco repetitivas.
   */
  private readStaticFile(filePath: string): string {
    try {
      const absolutePath = path.resolve(process.cwd(), filePath);

      // Retornar del cache si ya existe
      if (this.fileCache.has(absolutePath)) {
        return this.fileCache.get(absolutePath)!;
      }

      if (fs.existsSync(absolutePath)) {
        const content = fs.readFileSync(absolutePath, 'utf8');
        this.fileCache.set(absolutePath, content);
        return content;
      }
      return '';
    } catch (error) {
      console.warn(`⚠️ Error leyendo archivo estático ${filePath}:`, error);
      return '';
    }
  }

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (this.usingElevenLabs() && !this.elevenLabsApiKey) {
      console.error(
        '❌ ELEVENLABS_API_KEY no configurado. Se intentará fallback a Deepgram.',
      );
    }

    let currentCallSid = '';
    let mediaBeforeStartWarned = false;
    /** Tras `stop`, Twilio puede seguir enviando chunks de media: no loguear ni buscar sesión */
    let callStreamEnded = false;

    client.on('message', (raw: Buffer) => {
      void (async () => {
        try {
          const msg = JSON.parse(raw.toString()) as TwilioMsg;

          if (msg.event === 'connected') {
            return;
          }

          if (msg.event === 'start') {
            callStreamEnded = false;
            currentCallSid = msg.start?.callSid || '';
            console.log(`📞 [${currentCallSid}] Llamada iniciada`);
            mediaBeforeStartWarned = false;

            if (!currentCallSid) {
              console.error('❌ No se pudo obtener callSid del evento start');
              return;
            }

            await this.createSession(currentCallSid, client, msg.start);
            return;
          }

          if (msg.event === 'media') {
            if (callStreamEnded) {
              return;
            }
            if (!currentCallSid) {
              if (!mediaBeforeStartWarned) {
                console.warn(
                  '⚠️ Recibiendo eventos media antes del start, esperando evento start... (este mensaje no se repetirá)',
                );
                mediaBeforeStartWarned = true;
              }
              return;
            }

            this.forwardInboundAudio(currentCallSid, msg);
            return;
          }

          if (msg.event === 'stop') {
            console.log(`🛑 Llamada terminada.`);
            const sid = currentCallSid;
            // Si no se marcó ningún motivo previo, el cliente fue quien colgó
            const session = sid ? this.sessions.get(sid) : undefined;
            if (session && !session.terminadoPor) {
              session.terminadoPor = 'cliente';
            }
            callStreamEnded = true;
            currentCallSid = '';
            if (sid) {
              this.cleanupSession(sid);
            }
            client.close();
          }
        } catch (err) {
          console.error('❌ Error procesando mensaje Twilio:', err);
        }
      })();
    });
  }

  private async createSession(
    callSid: string,
    client: WebSocketClient,
    start?: TwilioStart['start'],
  ) {
    const existing = this.sessions.get(callSid);
    if (existing) {
      this.cleanupSession(callSid);
    }

    const customParameters = this.extractCustomParameters(
      start?.customParameters,
    );

    // Los IDs de knowledge se cargan en segundo plano para no bloquear el arranque del STT
    // (en streams no se usan aún para RAG por turno, pero se mantienen por compatibilidad futura)

    if (customParameters && !customParameters.shopDomain) {
      console.warn(`⚠️ [${callSid}] shopDomain NO está en customParameters`);
    }
    if (!customParameters || Object.keys(customParameters).length === 0) {
      console.warn(`⚠️ [${callSid}] No se recibieron customParameters`);
    }

    if (!customParameters?.instructions) {
      console.warn(
        `⚠️ [${callSid}] No se recibió agentInstruction desde Twilio`,
      );
    }

    // Extraer userId y shopDomain de customParameters para integración Shopify
    const userId = customParameters?.userId?.trim();
    const shopDomain = customParameters?.shopDomain?.trim();

    let userDocumentData: admin.firestore.DocumentData | undefined;

    if (userId) {
      try {
        const userDocRef = admin.firestore().collection('users').doc(userId);
        const userDoc = await userDocRef.get();
        if (userDoc.exists) {
          userDocumentData = userDoc.data();
        } else {
          console.warn(
            `⚠️ [${callSid}] No se encontró documento para el userId: ${userId}`,
          );
        }
      } catch (error) {
        console.error(
          `❌ [${callSid}] Error al cargar el documento del usuario ${userId}:`,
          error,
        );
      }
    }

    const instructions = this.resolveInstructions(customParameters);
    const voiceId = this.resolveVoiceId(customParameters);

    // console.log(
    //   `🔍 [Streams] CustomParameters recibidos para ${callSid}:`,
    //   JSON.stringify(customParameters, null, 2),
    // );

    if (!voiceId) {
      console.warn(
        `⚠️ [${callSid}] No se recibió voiceId/labsId; se usará fallback de entorno: ${this.elevenLabsTtsVoiceId}`,
      );
    } else {
      console.log(`🎤 [${callSid}] Voice ID configurado: ${voiceId}`);
    }
    const language = this.resolveLanguage(customParameters);

    const session: CallSession = {
      callSid,
      streamSid: start?.streamSid,
      client,
      sttProvider: this.sttProvider,
      customParameters,
      instructions,
      voiceId,
      language,
      queuedAudio: [],
      outboundBuffer: Buffer.alloc(0),
      readyForAudio: false,
      pendingGreeting: this.resolveGreeting(customParameters),
      greetingSent: false,
      responseLatencies: [],
      history: [],
      interceptedResponseText: '',
      agentSpeaking: false,
      interrupted: false,
      userId,
      userDocument: userDocumentData,
      shopifyContext: shopDomain ? { shopDomain } : undefined,
      knowledgeSourceIds: [],
      callStartTime: Date.now(),
      callerPhone: customParameters?.callerPhone,
      callDirection: 'inbound',
      conversationState: 'GREETING',
    };

    // Personalizar saludo con el companyName del usuario (reutiliza userDocumentData ya cargado)
    if (userId && userDocumentData?.companyName && session.pendingGreeting) {
      const companyName = userDocumentData.companyName as string;
      console.log(
        `👋 [${callSid}] Personalizando saludo con empresa: ${companyName}`,
      );
      if (session.pendingGreeting.trim().toLowerCase().startsWith('hola')) {
        session.pendingGreeting = session.pendingGreeting.replace(
          /^Hola([,.])?/i,
          `Hola$1 bienvenido a ${companyName}.`,
        );
      } else {
        session.pendingGreeting = `Bienvenido a ${companyName}. ${session.pendingGreeting}`;
      }
    }

    this.sessions.set(callSid, session);
    if (session.pendingGreeting) {
      this.maybeSendPendingGreeting(session);
    }
    if (this.usingElevenLabs(session)) {
      void this.connectToElevenLabs(session);
    } else {
      void this.connectToDeepgram(session);
    }

    if (customParameters?.agentId) {
      void this.loadAgentKnowledgeSourceIdsInBackground(
        callSid,
        Number(customParameters.agentId),
      );
    }

    // Shopify en segundo plano: no bloquear createSession (hasta ~5s antes); el primer turno usa cache vacío o fallback en enrichInstructions
    if (userId && shopDomain && session.shopifyContext) {
      void this.loadInitialShopifyContext(session).catch((err) => {
        console.warn(
          `⚠️ [${callSid}] Error en carga inicial Shopify (background):`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /**
   * Carga IDs de fuentes de conocimiento sin bloquear el inicio de la llamada.
   */
  private async loadAgentKnowledgeSourceIdsInBackground(
    callSid: string,
    agentId: number,
  ): Promise<void> {
    try {
      const agentSources =
        await this.agentKnowledgeService.getAgentKnowledgeSources(agentId);
      const session = this.sessions.get(callSid);
      if (!session) return;
      session.knowledgeSourceIds = agentSources.map((source) => source.id);
    } catch (err) {
      console.error(
        `❌ [${callSid}] Error al cargar IDs de fuentes de conocimiento (background):`,
        err,
      );
    }
  }

  /**
   * Carga el contexto inicial de Shopify (tienda y productos destacados).
   * Se invoca en segundo plano tras el arranque de la sesión para no retrasar STT ni la primera interacción.
   */
  private async loadInitialShopifyContext(session: CallSession): Promise<void> {
    if (!session.userId || !session.shopifyContext?.shopDomain) {
      return;
    }

    const userId = session.userId;
    const shopDomain = session.shopifyContext.shopDomain;

    // Timeout de 5 segundos para carga inicial
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Timeout cargando contexto Shopify')),
        5000,
      );
    });

    try {
      // 🔍 Buscar cliente por teléfono para filtrar pedidos (Minimización Premium)
      // Normalizar teléfono: eliminar espacios, guiones y paréntesis
      const rawPhone = session.customParameters?.callerPhone;
      const callerPhone = rawPhone
        ? rawPhone.replace(/[\s\-\(\)]/g, '')
        : undefined;
      let customerId: number | undefined;

      if (callerPhone) {
        console.log(
          `🔍 [${session.callSid}] Buscando cliente por teléfono (normalizado): ${callerPhone} (Original: ${rawPhone})`,
        );
        customerId =
          (await this.shopifyService.searchCustomerByPhone(
            userId,
            shopDomain,
            callerPhone,
          )) || undefined;
      }

      const loadPromise = Promise.all([
        this.shopifyService.getStoreInfo(userId, shopDomain),
        this.shopifyService.getProducts(userId, shopDomain),
        this.shopifyService.getOrders(userId, shopDomain, customerId),
      ]);

      const [storeResponse, productsResponse, ordersResponse] =
        await Promise.race([
          loadPromise.then((results) => {
            // Limpiar timeout si la promesa se resuelve antes
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            return results;
          }),
          timeoutPromise,
        ]);

      // Validar respuestas antes de usarlas
      if (!storeResponse || !storeResponse.store) {
        console.warn(
          `⚠️ [${session.callSid}] Respuesta de tienda Shopify inválida o vacía (userId: ${userId}, shopDomain: ${shopDomain})`,
        );
        return;
      }

      if (!productsResponse || !Array.isArray(productsResponse.products)) {
        console.warn(
          `⚠️ [${session.callSid}] Respuesta de productos Shopify inválida o vacía (userId: ${userId}, shopDomain: ${shopDomain})`,
        );
        return;
      }

      if (!ordersResponse || !Array.isArray(ordersResponse.orders)) {
        console.warn(
          `⚠️ [${session.callSid}] Respuesta de pedidos Shopify inválida o vacía (userId: ${userId}, shopDomain: ${shopDomain})`,
        );
        // Continuar sin pedidos (no es crítico)
      }

      // Filtrar productos destacados (buscar campo featured o usar primeros 10)
      let featuredProducts = productsResponse.products;

      // Intentar buscar productos con campo featured (aunque no esté en la interfaz normalizada)
      // Si no hay campo featured, usar primeros 10 productos
      if (featuredProducts.length > 10) {
        featuredProducts = featuredProducts.slice(0, 10);
      }

      // Filtrar pedidos recientes (últimos 10, ordenados por fecha)
      let recentOrders: NormalizedOrder[] = [];
      if (ordersResponse && Array.isArray(ordersResponse.orders)) {
        recentOrders = ordersResponse.orders
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )
          .slice(0, 10);
      }

      // Actualizar el contexto de Shopify en la sesión
      if (session.shopifyContext) {
        try {
          session.shopifyContext.store = storeResponse.store;
          session.shopifyContext.featuredProducts = featuredProducts;
          session.shopifyContext.orders = recentOrders;
          session.shopifyContext.loadedAt = Date.now();

          const storeName =
            storeResponse.store.name || shopDomain || 'tienda desconocida';
          console.log(
            `✅ [${session.callSid}] Contexto Shopify cargado: tienda "${storeName}", ${featuredProducts.length} productos destacados, ${recentOrders.length} pedidos recientes (userId: ${userId}, shopDomain: ${shopDomain})`,
          );
        } catch (contextError) {
          console.error(
            `❌ [${session.callSid}] Error actualizando contexto Shopify en sesión:`,
            contextError instanceof Error
              ? contextError.message
              : String(contextError),
          );
        }
      }
    } catch (error) {
      // Limpiar timeout si hubo un error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Manejar errores silenciosamente (log sin bloquear)
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorDetails =
        error instanceof Error && error.stack
          ? ` - Stack: ${error.stack.substring(0, 200)}`
          : '';

      console.warn(
        `⚠️ [${session.callSid}] Error cargando contexto Shopify (continuando sin datos) - userId: ${userId}, shopDomain: ${shopDomain}, error: ${errorMessage}${errorDetails}`,
      );

      // Continuar sin datos de Shopify - la sesión funciona sin ellos
    }
  }

  /**
   * Consulta datos de Shopify bajo demanda según el texto del usuario
   * Usa timeout de 3 segundos para no bloquear la conversación
   * Retorna los datos actualizados o null si falla/timeout
   */
  private async queryShopifyDataIfNeeded(
    session: CallSession,
    userText: string,
  ): Promise<ShopifyContext | null> {
    if (!session.userId || !session.shopifyContext?.shopDomain) {
      return null;
    }

    const userId = session.userId;
    const shopDomain = session.shopifyContext.shopDomain;

    try {
      // Heurística simple para detectar qué tipo de datos necesita el usuario
      const textLower = userText.toLowerCase();
      const needsProducts =
        /\b(producto|productos|artículo|artículos|item|items|catálogo|catálogos|catalogo|catalogos)\b/.test(
          textLower,
        );
      const needsStoreInfo =
        /\b(tienda|información|info|datos|nombre|email|contacto)\b/.test(
          textLower,
        );

      // Si no hay indicios claros, no hacer consulta (usar cache)
      if (!needsProducts && !needsStoreInfo) {
        return null;
      }

      // Timeout de 3 segundos para consultas durante conversación
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Timeout consultando datos Shopify')),
          3000,
        );
      });

      // NOTA: NO resetear session.shopifyContext aquí
      // Ya existe y contiene datos del cache inicial (productos, pedidos, store)
      // Solo actualizaremos campos específicos si se consultan

      // Hacer consultas en paralelo si ambas son necesarias
      const queries: Promise<unknown>[] = [];
      const queryTypes: ('products' | 'store')[] = [];

      if (needsProducts) {
        queries.push(this.shopifyService.getProducts(userId, shopDomain));
        queryTypes.push('products');
      }
      if (needsStoreInfo) {
        queries.push(this.shopifyService.getStoreInfo(userId, shopDomain));
        queryTypes.push('store');
      }

      if (queries.length === 0) {
        return null;
      }

      const results = await Promise.race([
        Promise.all(queries).then((results) => {
          // Limpiar timeout si la promesa se resuelve antes
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          return results;
        }),
        timeoutPromise,
      ]);

      let updated = false;

      // Procesar resultados según el tipo de consulta
      try {
        results.forEach((result, index) => {
          const queryType = queryTypes[index];
          if (!result) {
            console.warn(
              `⚠️ [${session.callSid}] Resultado de consulta Shopify vacío para tipo: ${queryType}`,
            );
            return;
          }

          if (queryType === 'products') {
            const productsResponse = result as NormalizedProductsResponse;
            if (
              !productsResponse ||
              !Array.isArray(productsResponse.products)
            ) {
              console.warn(
                `⚠️ [${session.callSid}] Respuesta de productos Shopify inválida`,
              );
              return;
            }

            // Filtrar productos destacados (primeros 10)
            let featuredProducts = productsResponse.products;
            if (featuredProducts.length > 10) {
              featuredProducts = featuredProducts.slice(0, 10);
            }

            if (session.shopifyContext) {
              session.shopifyContext.featuredProducts = featuredProducts;
              updated = true;
            }
          } else if (queryType === 'store') {
            const storeResponse = result as NormalizedStoreResponse;
            if (!storeResponse || !storeResponse.store) {
              console.warn(
                `⚠️ [${session.callSid}] Respuesta de tienda Shopify inválida`,
              );
              return;
            }

            if (session.shopifyContext) {
              session.shopifyContext.store = storeResponse.store;
              updated = true;
            }
          }
        });
      } catch (processingError) {
        console.error(
          `❌ [${session.callSid}] Error procesando resultados de consulta Shopify:`,
          processingError instanceof Error
            ? processingError.message
            : String(processingError),
        );
        // Continuar sin actualizar el contexto si hay error en el procesamiento
      }

      if (updated && session.shopifyContext) {
        session.shopifyContext.loadedAt = Date.now();
        console.log(
          `✅ [${session.callSid}] Datos Shopify actualizados bajo demanda (userId: ${userId}, shopDomain: ${shopDomain})`,
        );
        return session.shopifyContext;
      }

      return null;
    } catch (error) {
      // Manejar errores silenciosamente (log sin bloquear)
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorDetails =
        error instanceof Error && error.stack
          ? ` - Stack: ${error.stack.substring(0, 200)}`
          : '';

      console.warn(
        `⚠️ [${session.callSid}] Error consultando datos Shopify bajo demanda (usando cache) - userId: ${userId}, shopDomain: ${shopDomain}, error: ${errorMessage}${errorDetails}`,
      );

      // Retornar null para usar cache existente
      return null;
    }
  }

  /**
   * Enriquece las instrucciones del sistema con datos de Shopify si están disponibles
   * Formatea los datos de la tienda y productos destacados como JSON dentro del prompt
   */
  private enrichInstructions(session: CallSession): string {
    let baseInstructions = session.instructions;

    try {
      // 0. Limpieza proactiva: Si no hay Shopify, eliminar rastro de la sección 7 de las instrucciones base
      const hasValidShopify =
        session.shopifyContext?.shopDomain &&
        !session.shopifyContext.shopDomain.includes('example.com');

      if (!hasValidShopify && baseInstructions) {
        // Regex para detectar el bloque de Shopify en el template (sección 7)
        const shopifySectionRegex =
          /============================================================\s*## 7\. USO DEL CONTEXTO DE SHOPIFY[\s\S]*?(?============================================================\s*## 8\.)/i;
        if (shopifySectionRegex.test(baseInstructions)) {
          console.log(
            `🧹 [${session.callSid}] Eliminando Sección 7 de Shopify de las instrucciones base (sin dominio)`,
          );
          baseInstructions = baseInstructions.replace(shopifySectionRegex, '');
        }
      }

      // 1. Cargar reglas de voz (siempre)
      const voiceRules = this.readStaticFile('src/prompts/voice-rules.md');

      // 2. Cargar conocimiento de empresa (OPTIMIZADO)
      // En lugar de cargar todo el privacy_policy y terms_and_conditions que consumen miles de tokens,
      // Solo indicamos al agente que se apoye en su conocimiento interno y herramientas, 
      // o que pida al usuario enviar un email para detalles legales complejos.
      let companyKnowledge = '';
      const knowledgeInfo = 'Para políticas de privacidad, términos de servicio o garantías, responde de forma general o solicita al usuario que consulte la web o escriba un correo a soporte. Sé muy conciso.';
      companyKnowledge = `\n============================================================\n## 🏢 CONOCIMIENTO DE LA EMPRESA 🏢\n============================================================\n${knowledgeInfo}\n============================================================\n`;


      // 3. Inyectar Datos Clave del Usuario (siempre que existan)
      let userDataString = '';
      if (session.userDocument) {
        const companyName = session.userDocument.companyName;
        const userEmail = session.userDocument.email;
        const shopifyDomain = session.userDocument.shopifyDomain;
        const callerPhone = session.customParameters?.callerPhone;

        userDataString += `\n============================================================\n## 👤 CONTEXTO DEL USUARIO 👤\n============================================================\n`;
        if (session.userId)
          userDataString += `- ID de Usuario: ${session.userId}\n`;
        if (companyName)
          userDataString += `- Nombre de la Empresa: ${companyName}\n`;
        if (userEmail) userDataString += `- Email de Contacto: ${userEmail}\n`;
        if (shopifyDomain)
          userDataString += `- Dominio Shopify Asociado: ${shopifyDomain}\n`;
        if (callerPhone)
          userDataString += `- Teléfono desde el que llama: ${callerPhone}\n`;
        userDataString += `============================================================\n\n`;
      }

      // 4. Datos de Shopify (solo si existe dominio y está habilitado)
      let finalShopifyContext = '';
      let fallbackInstructions = '';
      const shopifyContext = session.shopifyContext;

      if (shopifyContext?.shopDomain && !shopifyContext.shopDomain.includes('example.com')) {
        if (
          !shopifyContext.store &&
          !shopifyContext.featuredProducts?.length &&
          !shopifyContext.orders?.length
        ) {
          console.warn(
            `⚠️ [${session.callSid}] Sin datos de Shopify para dominio: ${shopifyContext.shopDomain}`,
          );
          fallbackInstructions = `
============================================================
## 🚫 NO SE ENCONTRARON DATOS DE SHOPIFY 🚫
============================================================
Aunque la tienda "${shopifyContext.shopDomain}" está configurada, no hemos podido recuperar productos ni pedidos automáticamente para este número (${session.customParameters?.callerPhone || 'Desconocido'}).

**Instrucciones:**
1. NO inventes información.
2. Pide al usuario el **Número de Pedido** o el **Email** para buscarlo manualmente si es necesario.
============================================================
`;
        } else {
          // Construir contexto de Shopify como JSON estructurado (OPTIMIZADO)
          const shopifyData: any = {};
          if (shopifyContext.store) shopifyData.tienda = shopifyContext.store;

          if (shopifyContext.featuredProducts?.length) {
            // Mapeo ligero para ahorrar tokens
            shopifyData.productosDestacados = shopifyContext.featuredProducts.map(
              (p) => ({
                nombre: p.title,
                precio: p.variants?.[0]?.price,
                estado: p.status,
                id: p.productId,
              }),
            );
          }

          if (shopifyContext.orders?.length) {
            // Mapeo ligero para ahorrar tokens
            shopifyData.pedidosRecientes = shopifyContext.orders.map((o) => ({
              numero: o.orderName,
              estado: o.status,
              estadoEnvio: o.fulfillmentStatus,
              total: o.totalPrice,
              fecha: o.createdAt ? o.createdAt.split('T')[0] : '',
            }));
          }

          let shopifyContextJson = '';
          try {
            shopifyContextJson = JSON.stringify(shopifyData, null, 2);
            let shopifyPromptTemplate = this.readStaticFile(
              'src/prompts/shopify-context.md',
            );
            if (!shopifyPromptTemplate) {
              shopifyPromptTemplate = `\nContexto Shopify:\n\`\`\`json\n{{SHOPIFY_CONTEXT_JSON}}\n\`\`\`\n`;
            }
            finalShopifyContext = shopifyPromptTemplate.replace(
              '{{SHOPIFY_CONTEXT_JSON}}',
              shopifyContextJson,
            );
          } catch (jsonError) {
            console.error(
              `❌ [${session.callSid}] Error serializando datos Shopify a JSON:`,
              jsonError instanceof Error
                ? jsonError.message
                : String(jsonError),
            );
          }
        }
      }

      // 5. Contexto de Estado de Conversación (Conversation Manager)
      let conversationStatePrompt = '';
      if (session.conversationState) {
        conversationStatePrompt = `\n============================================================\n## 🔄 ESTADO DE LA CONVERSACIÓN 🔄\n============================================================\n[ESTADO ACTUAL: ${session.conversationState}]\nAdapta tu respuesta y tu objetivo actual según este estado.\n============================================================\n`;
      }

      // 6. Ensamblar el prompt final
      const enrichedInstructions = [
        userDataString,
        conversationStatePrompt,
        baseInstructions,
        voiceRules ? `\n${voiceRules}\n` : '',
        companyKnowledge,
        fallbackInstructions,
        finalShopifyContext,
      ]
        .filter(Boolean)
        .join('\n');

      return enrichedInstructions;
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error en enrichInstructions:`,
        error instanceof Error ? error.message : String(error),
      );
      return baseInstructions;
    }
  }

  private connectToElevenLabs(session: CallSession) {
    if (!this.elevenLabsApiKey) {
      console.error('❌ ELEVENLABS_API_KEY ausente. No se puede iniciar STT.');
      this.failoverToDeepgram(
        session,
        'ELEVENLABS_API_KEY ausente; activando fallback a Deepgram',
      );
      return;
    }

    const language = session.language || this.elevenLabsLanguage;
    // ElevenLabs requiere model_id en la query para Realtime STT
    const url = `${this.elevenLabsSttUrl}?model_id=${encodeURIComponent(this.elevenLabsSttModel)}&language=${encodeURIComponent(language)}`;

    const ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.elevenLabsApiKey,
        'User-Agent': 'llamalo-ai/streams-gateway',
      },
    });

    session.voiceAgentSocket = ws;
    session.sttSocket = ws;

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      const statusMessage = res.statusMessage;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        console.error(
          `❌ [${session.callSid}] ElevenLabs STT unexpected-response ${status} ${statusMessage} - body: ${body.substring(0, 500)}`,
        );
        this.failoverToDeepgram(
          session,
          `unexpected-response ${status} ${statusMessage}`,
        );
      });
    });

    ws.on('open', () => {
      console.log(`🔌 STT ElevenLabs conectado`);
      try {
        ws.send(
          JSON.stringify({
            event: 'start',
            // Enviar model_id; dejamos model por compatibilidad hacia atrás
            model_id: this.elevenLabsSttModel,
            model: this.elevenLabsSttModel,
            language,
            format: 'json',
            encoding: 'mulaw',
            sample_rate: 8000,
          }),
        );
      } catch (err) {
        console.warn(
          `⚠️ [${session.callSid}] No se pudo enviar start a ElevenLabs STT`,
          err,
        );
      }
      session.readyForAudio = true;
      this.flushQueuedAudio(session);
      this.maybeSendPendingGreeting(session);
    });

    ws.on('message', (data, isBinary) =>
      this.handleElevenLabsMessage(session, data, Boolean(isBinary)),
    );

    ws.on('close', (code) => {
      if (code !== 1000 && code !== 1001) {
        console.log(`🔌 Conexión ElevenLabs STT cerrada (${code})`);
      }
      session.readyForAudio = false;
    });

    ws.on('error', (error) => {
      console.error(
        `❌ [${session.callSid}] Error en ElevenLabs STT WS:`,
        error,
      );
      this.systemLogsService.logError({
        type: LogType.CALL_FAILED,
        message: 'Error en ElevenLabs STT WS (Failover iniciado)',
        reason: error.message,
        metadata: { callSid: session.callSid, userId: session.userId }
      });
      session.terminadoPor = 'error';
      this.failoverToDeepgram(session, `error: ${error.message || 'ws error'}`);
    });
  }

  private failoverToDeepgram(session: CallSession, reason: string) {
    if (session.sttProvider === 'deepgram') {
      return;
    }
    if (!this.deepgramApiKey) {
      console.error(
        `❌ [${session.callSid}] Falló ElevenLabs (${reason}) y no hay DG_VOICE_AGENT_API_KEY/DG_API_KEY configurado para fallback.`,
      );
      return;
    }
    console.warn(
      `⚠️ [${session.callSid}] Fallback a Deepgram tras error con ElevenLabs (${reason}).`,
    );
    session.sttProvider = 'deepgram';
    session.readyForAudio = false;
    try {
      session.sttSocket?.close();
    } catch (err) {
      console.warn(`⚠️ [${session.callSid}] Error cerrando sttSocket:`, err);
    }
    try {
      session.voiceAgentSocket?.close();
    } catch (err) {
      console.warn(
        `⚠️ [${session.callSid}] Error cerrando voiceAgentSocket:`,
        err,
      );
    }
    session.sttSocket = undefined;
    session.voiceAgentSocket = undefined;
    this.connectToDeepgram(session);
  }

  private handleElevenLabsMessage(
    session: CallSession,
    data: RawData,
    isBinary: boolean,
  ) {
    if (isBinary) {
      return;
    }

    const raw = this.rawDataToString(data);
    let message: Record<string, unknown> = {};
    try {
      message = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `⚠️ [${session.callSid}] Mensaje STT no parseable:`,
        err,
        raw,
      );
      return;
    }

    const text =
      (message.text as string) ||
      (message.transcript as string) ||
      (message.message as string) ||
      '';
    const isFinal =
      Boolean(message.is_final) ||
      Boolean(message.final) ||
      (typeof message.type === 'string' &&
        message.type.toLowerCase().includes('final'));

    if (!text.trim()) {
      return;
    }

    if (isFinal) {
      // No procesar eco/ruido como turno de usuario mientras suena el saludo
      if (session.allowInterruptions === false) {
        return;
      }
      // Reiniciar estado antes de procesar el nuevo transcript
      session.interrupted = false;
      void this.handleFinalTranscript(session, text.trim());
    } else {
      // Misma regla que Deepgram: durante el saludo (allowInterruptions false) no cortar por parciales
      if (session.allowInterruptions === false) {
        return;
      }
      // Solo interrumpimos si el agente ESTÁ enviando audio realmente (TTS) o lleva un buen rato hablando
      // NO interrumpimos durante el pensamiento o procesamiento inicial del LLM.
      if (
        (session.agentSpeaking || session.currentTTSRequest) &&
        !session.interrupted
      ) {
        // Solo interrumpimos si el ruido/voz detectado es algo consistente (más de 12 caracteres)
        // para evitar que ruidos cortos o ecos corten al agente.
        if (text.trim().length > 12) {
          console.log(
            `🛑 [${session.callSid}] Interrupción por voz del usuario (parcial: "${text.substring(0, 30)}...")`,
          );
          session.interrupted = true;
          session.agentSpeaking = false;
          session.silenceInterventions = 0;

          if (session.ttsCancelStream) {
            session.ttsCancelStream();
            session.ttsCancelStream = undefined;
          }

          session.outboundBuffer = Buffer.alloc(0);

          // Vaciar el buffer de Twilio instantáneamente
          if (session.streamSid) {
            session.client.send(
              JSON.stringify({
                event: 'clear',
                streamSid: session.streamSid,
              }),
            );
          }
        }
      }
    }
  }

  private async handleFinalTranscript(
    session: CallSession,
    text: string,
    role: 'user' | 'system' = 'user',
  ) {
    // 🛑 DETENER TEMPORIZADOR DE SILENCIO: El agente va a procesar y hablar
    this.stopSilenceTimer(session);

    if (!this.isCallSessionLive(session)) {
      return;
    }

    // Invalidar cualquier colgado en curso (espera larga antes de Twilio) si el usuario vuelve a hablar
    if (role === 'user') {
      session.hangupNonce = (session.hangupNonce ?? 0) + 1;
    }

    // Latencia solo tiene sentido para turnos reales del usuario (no intervención por silencio de sistema)
    const userStartedAt =
      role === 'user'
        ? (session.userSpeakingStartTime ?? undefined)
        : undefined;

    // Resetear estado de interrupción para permitir nueva respuesta
    session.interrupted = false;
    session.agentSpeaking = false;
    session.interceptedResponseText = '';
    session.outboundBuffer = Buffer.alloc(0);

    // 🔥 FIX: Corrección dinámica para nombres de empresas
    const correctedText =
      role === 'user' ? await this.basicCompanyCorrection(text, session) : text;

    if (!this.isCallSessionLive(session)) {
      return;
    }

    // 🛡️ FILTRO ANTI-ECO (SALUDO INICIAL):
    // Si el texto que escuchamos es casi idéntico al saludo inicial que dijo el bot, lo ignoramos.
    // Esto evita que el bot se responda a sí mismo si se escucha por el altavoz.
    if (role === 'user' && session.pendingGreeting) {
      const cleanTranscript = correctedText.toLowerCase().replace(/[.,!¡¿?]/g, '').trim();
      const cleanGreeting = session.pendingGreeting.toLowerCase().replace(/[.,!¡¿?]/g, '').trim();
      
      // Si el transcript contiene gran parte del saludo o viceversa, es eco.
      if (
        cleanTranscript.length > 10 && 
        (cleanGreeting.includes(cleanTranscript) || cleanTranscript.includes(cleanGreeting))
      ) {
        console.log(`🛡️ [${session.callSid}] Eco detectado y bloqueado: "${text}" coincide con el saludo.`);
        return;
      }
    }

    if (role === 'user') {
      console.log(`💬 [${session.callSid}] Usuario dijo: "${text}"`);
      session.history.push({ role: 'user', content: correctedText });
      session.silenceInterventions = 0; // Resetear contador de intervenciones por silencio
      if (session.terminadoPor === 'silencio') {
        session.terminadoPor = undefined; // Limpiar flag de silencio si el usuario responde
      }
    } else {
      // Si es sistema (silencio), inyectamos una instrucción clara
      session.history.push({
        role: 'system',
        content: text,
      });
    }

    if (role === 'user' && correctedText !== text) {
      console.log(
        `🔧 [${session.callSid}] Texto corregido: "${text.substring(0, 50)}" → "${correctedText.substring(0, 50)}"`,
      );
    }

    // ⚡ INTENT DETECTION LIGERO (Reducción de latencia)
    // Solo para mensajes de usuario, no para intervenciones de sistema
    if (role === 'user') {
      const fastIntentResponse = this.detectFastIntent(correctedText, session);
      if (fastIntentResponse) {
        if (!this.isCallSessionLive(session)) {
          return;
        }
        
        // Si el intent es de ignorar ruido, quitar el turno de usuario del historial y salir
        if (fastIntentResponse === 'IGNORE_NOISE') {
          const last = session.history[session.history.length - 1];
          if (last?.role === 'user') {
            session.history.pop();
          }
          return;
        }

        console.log(
          `⚡ [${session.callSid}] Intent detectado, respuesta rápida: "${fastIntentResponse}"`,
        );

        session.history.push({
          role: 'assistant',
          content: fastIntentResponse,
        });

        // Registrar latencia de respuesta rápida
        if (userStartedAt != null) {
          const latency = Date.now() - userStartedAt;
          session.responseLatencies.push(latency);
          if (
            latency >= 0 &&
            latency < 15000 &&
            session.userId &&
            session.customParameters?.twilioAccountId &&
            this.isCallSessionLive(session)
          ) {
            try {
              await this.metricsService.saveLatencyMeasurement(
                session.userId,
                parseInt(session.customParameters.twilioAccountId),
                latency,
              );
            } catch (error) {
              console.warn(`[Latency] Error guardando latencia intent:`, error);
            }
          }
        }

        session.agentSpeaking = true;
        session.lastAgentStartSpeakingTime = Date.now();

        // Encolar y reproducir TTS de la respuesta rápida
        try {
          if (!this.isCallSessionLive(session)) {
            return;
          }
          await this.streamElevenLabsTTS(session, fastIntentResponse);
        } catch (err) {
          console.error(`❌ [${session.callSid}] Error en TTS rápido:`, err);
        } finally {
          // 🟢 REINICIAR TEMPORIZADOR DE SILENCIO: El agente terminó el intent rápido, esperamos al usuario
          if (this.isCallSessionLive(session) && !session.interrupted) {
            this.resetSilenceTimer(session);
          }
        }
        return; // Cortocircuitar el LLM
      }
    }

    try {
      // 🚀 OPTIMIZACIÓN DE LATENCIA: Consultar Shopify solo si el mensaje es relevante
      const lowerText = text.toLowerCase();
      const isShopifyRelevant =
        lowerText.includes('pedido') ||
        lowerText.includes('orden') ||
        lowerText.includes('compr') ||
        lowerText.includes('rastre') ||
        lowerText.includes('status') ||
        lowerText.includes('donde esta');

      if (isShopifyRelevant) {
        try {
          // Timeout agresivo para Shopify (1.5s) para no bloquear la llamada
          await Promise.race([
            this.queryShopifyDataIfNeeded(session, text),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Shopify Timeout')), 1500),
            ),
          ]);
        } catch (error) {
          // Si falla o hay timeout, se usa el cache existente en session.shopifyContext
          console.warn(
            `⚠️ [${session.callSid}] Shopify saltado por lentitud o error (usando cache).`,
          );
        }
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }

      // Enriquecer las instrucciones con datos de Shopify, Reglas de Voz, etc.
      let enrichedInstructions: string;
      try {
        enrichedInstructions = this.enrichInstructions(session);
      } catch (error) {
        enrichedInstructions = session.instructions;
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }

      const agentResponseStart = Date.now(); // Marcar inicio de respuesta del agente

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
                    'El teléfono del usuario si te lo ha proporcionado en la llamada. Si no lo sabes, usa el número desde el que llama (callerPhone).',
                },
              },
              required: ['resumen_problema'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'cambiar_estado',
            description:
              'Cambia el estado lógico de la conversación (Conversation Manager). Úsalo cuando el flujo cambie naturalmente de fase. GREETING: saludo inicial; DISCOVERY: entendiendo el problema; SUPPORT: resolviendo dudas; CLOSING: despidiéndose.',
            parameters: {
              type: 'object',
              properties: {
                nuevo_estado: {
                  type: 'string',
                  enum: ['GREETING', 'DISCOVERY', 'SUPPORT', 'CLOSING'],
                  description: 'El nuevo estado de la conversación.',
                },
              },
              required: ['nuevo_estado'],
            },
          },
        },
      ];

      // Detectar si el agente actual es Xenon (para decidir si pasarle la Tool o no)
      const agentName = session.customParameters?.agentName?.toLowerCase() || '';
      const isXenon =
        agentName.includes('xenon') ||
        session.instructions.toLowerCase().includes('xenon');

      // Solo pasar la tool de escalar a soporte si el agente es Xenon
      const safeTools = isXenon ? tools : undefined;

      // Implementar Sliding Window: Retener solo los últimos N mensajes para no agotar tokens de OpenAI
      const maxHistory = 10; // Últimos 5 turnos (usuario + asistente)
      const recentHistory = session.history.slice(-maxHistory);

      // Primer turno real del usuario (saludo por voz no va en history): modelo más rápido para bajar latencia
      const isFirstLlmTurn =
        recentHistory.length === 1 && recentHistory[0].role === 'user';
      const modelForTurn = isFirstLlmTurn
        ? this.llmModelFirstTurn
        : this.llmModel;
      const maxTokensForTurn = isFirstLlmTurn
        ? this.llmMaxTokensFirstTurn
        : this.llmMaxTokens;

      if (isFirstLlmTurn) {
        console.log(
          `⚡ [${session.callSid}] Primer turno LLM: model=${modelForTurn}, max_tokens=${maxTokensForTurn}`,
        );
      }

      // Llamada a OpenAI en modo STREAM
      let stream;
      try {
        stream = await this.openai.chat.completions.create({
          model: modelForTurn,
          temperature: this.llmTemperature,
          max_tokens: maxTokensForTurn,
          messages: [
            { role: 'system', content: enrichedInstructions },
            ...recentHistory,
          ],
          ...(safeTools && { tools: safeTools }),
          stream: true,
        });
      } catch (err) {
        console.error(`❌ [${session.callSid}] Error al llamar a OpenAI:`, err);
        session.terminadoPor = 'error';
        this.systemLogsService.logError({
          type: LogType.CALL_FAILED,
          message: 'Error en la llamada a OpenAI',
          reason: err.message,
          metadata: { callSid: session.callSid, userId: session.userId }
        });
        session.interrupted = false;
        session.agentSpeaking = false;
        return;
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }

      // 🔥 FIX: Marcar explícitamente que el LLM está procesando ANTES de consumir el stream
      // Pero OJO, no marcamos agentSpeaking = true todavía, porque el agente NO está hablando,
      // apenas estamos conectando con OpenAI.
      // Usaremos un nuevo flag o simplemente comprobamos si currentTTSRequest existe para el barge-in
      session.interrupted = false;
      session.agentSpeaking = false; // Aún no habla
      session.allowInterruptions = true;

      // Calcular y guardar latencia (desde que el usuario empezó a hablar hasta inicio de respuesta)
      if (userStartedAt != null) {
        const latency = agentResponseStart - userStartedAt;
        session.responseLatencies.push(latency);

        if (latency >= 0) {
          console.log(`🗣️ [${session.callSid}] Latencia: ${latency}ms`);
        }

        // Solo persistir latencias válidas y realistas (evitar negativas o mayores a 15s por fallos de sincronización)
        if (
          latency >= 0 &&
          latency < 15000 &&
          session.userId &&
          session.customParameters?.twilioAccountId &&
          this.isCallSessionLive(session)
        ) {
          try {
            await this.metricsService.saveLatencyMeasurement(
              session.userId,
              parseInt(session.customParameters.twilioAccountId),
              latency,
            );
          } catch (error) {
            console.warn(`[Latency] Error guardando latencia:`, error);
          }
        } else if (latency >= 15000) {
          console.warn(`⚠️ [${session.callSid}] Latencia ignorada por ser irrealmente alta (${latency}ms). Posible desincronización de userStartedAt.`);
        }
      }

      // Cola de promesas para garantizar que las frases se envíen a ElevenLabs y se reproduzcan en orden
      let ttsQueue = Promise.resolve();

      // FIX CRÍTICO: Asegurarse de que interrupted sea false antes de empezar el stream del LLM
      session.interrupted = false;

      let fullResponse = '';
      let sentenceBuffer = '';
      let isFirstChunk = true; // Para detectar el primer fragmento de la respuesta
      let functionCallName = '';
      let functionCallArgs = '';
      let shouldHangup = false;

      // Puntuaciones que indican un buen lugar para cortar y enviar a hablar
      const strongEnders = new Set(['.', '!', '?', '\n']);
      // Puntuaciones débiles que usamos SOLO si es el principio de la frase para empezar rápido
      const weakEnders = new Set([',', ':', ';']);

      for await (const chunk of stream) {
        if (!this.isCallSessionLive(session)) {
          break;
        }
        if (session.interrupted) {
          console.log(
            `🛑 [${session.callSid}] Generación LLM interrumpida por el usuario.`,
          );
          break; // Salir del bucle si el usuario interrumpe
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

        // En cuanto recibimos el primer token real de respuesta, el agente "empieza a hablar" virtualmente
        if (!session.agentSpeaking) {
          session.agentSpeaking = true;
          session.lastAgentStartSpeakingTime = Date.now(); // Registrar inicio para protección de barge-in
        }

        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          fullResponse += token;
          sentenceBuffer += token;

          // Normalizar cualquier variante de "End Call" o "END_CALL" al token [END_CALL] en cualquier parte del buffer
          sentenceBuffer = sentenceBuffer.replace(
            /\[?END[\s_]*CALL\]?/gi,
            '[END_CALL]',
          );

          // 🔍 Detectar señal de colgado [END_CALL]
          if (sentenceBuffer.includes('[END_CALL]')) {
            console.log(
              `🔚 [${session.callSid}] Señal [END_CALL] (o fallback "End Call") detectada.`,
            );
            shouldHangup = true;
            // Limpiar el buffer de CUALQUIER rastro de la señal inmediatamente para que no llegue a TTS
            sentenceBuffer = sentenceBuffer.replace(/\[?END[\s_]*CALL\]?/gi, '');
          }

          // Si el token contiene un fin de frase o la frase es suficientemente larga y encontramos una pausa
          const lastChar = token.slice(-1);
          const isSentenceEnd = strongEnders.has(lastChar);

          // Enviar en comas si la frase ya tiene >5 palabras (para evitar que hable sin respirar),
          // O si es el PRIMER chunk y tiene al menos 1 palabra (ej: "Claro,", "Sí,")
          const wordsCount = sentenceBuffer.trim().split(' ').length;
          
          // FORZAR PUNTUACIÓN (Anti-Metralleta):
          // Si el bot ha dicho 15 palabras y no hay puntuación, forzamos un corte enviando lo que hay.
          // El TTS interpretará este corte del chunk como una micro pausa natural.
          const isTooLongWithoutPause = wordsCount >= 15;

          const isPauseEnd =
            weakEnders.has(lastChar) &&
            (wordsCount > 5 || (isFirstChunk && wordsCount >= 1));

          if (isSentenceEnd || isPauseEnd || isTooLongWithoutPause) {
            if (isFirstChunk) isFirstChunk = false; // Ya enviamos el primer fragmento

            let sentenceToSend = sentenceBuffer.trim();
            // Limpieza total: eliminar [END_CALL] y cualquier variante de "End Call" vocalizado (sin anclaje $)
            sentenceToSend = sentenceToSend
              .replace(/\[?END[\s_]*CALL\]?/gi, '')
              .trim();
            if (sentenceToSend) {
              // Encolar la frase para mantener el orden de reproducción secuencial
              const currentSentence = sentenceToSend;
              ttsQueue = ttsQueue.then(async () => {
                if (!session.interrupted) {
                  console.log(`🔊 [${session.callSid}] Enviando chunk a TTS: "${currentSentence}"`);
                  await this.streamElevenLabsTTS(session, currentSentence);
                }
              });
            }
            sentenceBuffer = ''; // Reiniciar el buffer de la frase actual
          }
        }
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }

      // Enviar cualquier texto restante en el buffer que no haya terminado en puntuación
      if (!session.interrupted && sentenceBuffer.trim()) {
        let remainingText = sentenceBuffer.trim();
        // Normalizar "End Call" al token [END_CALL] (sin anclaje $)
        remainingText = remainingText.replace(
          /\[?END[\s_]*CALL\]?/gi,
          '[END_CALL]',
        );
        if (remainingText.includes('[END_CALL]')) {
          shouldHangup = true;
          remainingText = remainingText.replace(/\[?END[\s_]*CALL\]?/gi, '').trim();
        }
        // Restos de token partido (p. ej. solo "]" tras quitar [END_CALL] en streaming)
        remainingText = remainingText.replace(/^[\[\]]+|[\[\]]+$/g, '').trim();
        if (remainingText && !/^[\s\[\]]+$/.test(remainingText)) {
          ttsQueue = ttsQueue.then(async () => {
            if (!session.interrupted) {
              console.log(`🔊 [${session.callSid}] Enviando chunk final a TTS: "${remainingText}"`);
              await this.streamElevenLabsTTS(session, remainingText);
            }
          });
        }
      }

      // Esperar a que todos los audios terminen de generarse/enviarse
      await ttsQueue;
      
      // Asegurarnos de vaciar cualquier audio pendiente en el buffer antes de continuar
      this.flushOutboundAudioRemainder(session);

      // --- MANEJO DE TOOLS (LLAMADA A FUNCIONES) ---
      if (
        functionCallName === 'cambiar_estado' &&
        !session.interrupted
      ) {
        console.log(`🔀 [${session.callSid}] Ejecutando tool: ${functionCallName}`);
        try {
          const args = JSON.parse(functionCallArgs);
          const { nuevo_estado } = args;
          
          if (['GREETING', 'DISCOVERY', 'SUPPORT', 'CLOSING'].includes(nuevo_estado)) {
            session.conversationState = nuevo_estado as any;
            console.log(`✅ [${session.callSid}] Estado actualizado a: ${nuevo_estado}`);
          }
          
          // Registrar en el historial para que el LLM lo sepa
          const toolCallId = `call_${Date.now()}`;
          session.history.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: { name: functionCallName, arguments: functionCallArgs },
            }],
          } as any);

          session.history.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify({ success: true, message: `Estado cambiado a ${nuevo_estado}` }),
          } as any);

          // Si el LLM no generó ningún texto y solo cambió el estado, le pedimos que continúe
          if (!fullResponse.trim() && !session.interrupted) {
            return this.handleFinalTranscript(
              session,
              '(SISTEMA: Has cambiado de estado correctamente. Ahora proporciona la siguiente respuesta al usuario, si es necesario.)',
            );
          }
        } catch (e) {
          console.error(`❌ [${session.callSid}] Error procesando cambiar_estado:`, e);
        }
      } else if (
        functionCallName === 'escalar_a_soporte_humano' &&
        !session.interrupted
      ) {
        console.log(
          `📧 [${session.callSid}] Ejecutando tool: ${functionCallName}`,
        );
        try {
          const args = JSON.parse(functionCallArgs);
          const { resumen_problema, telefono_usuario } = args;

          // Intentar obtener el email real del usuario desde Firestore
          let userEmail: string | undefined = undefined;
          if (session.userId) {
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
              console.warn(
                `⚠️ No se pudo obtener el email del usuario ${session.userId} desde Firestore:`,
                error,
              );
            }
          }

          // Enviar el email
          try {
            await this.emailService.sendSupportTicket(
              session.userId || 'Desconocido',
              telefono_usuario ||
                session.customParameters?.callerPhone ||
                'No proporcionado',
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
            console.error(
              `❌ [${session.callSid}] Error al enviar email de soporte:`,
              emailError,
            );

            // Si el email falla, informamos al LLM para que le pida al usuario escribir directamente
            return this.handleFinalTranscript(
              session,
              '(SISTEMA: Error crítico al enviar el ticket por email. Por favor, discúlpate amablemente y dile al usuario que hubo un problema técnico temporal y que debe escribir directamente a team@llamalo.ai para que le ayudemos.)',
            );
          }
        } catch (e) {
          console.error(
            `❌ [${session.callSid}] Error procesando tool call:`,
            e,
          );
        }
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }

      // Actualizar el historial completo una vez terminado
      if (fullResponse.trim()) {
        const cleanedResponse = fullResponse
          .replace(/\[?END[\s_]*CALL\]?/gi, '') // Limpieza más robusta
          .trim();
        const finalContent = session.interrupted
          ? cleanedResponse + ' [Interrumpido por el usuario antes de terminar]'
          : cleanedResponse;

        session.history.push({ role: 'assistant', content: finalContent });
      }

      // Marcar que el agente terminó de hablar solo si no fue interrumpido por otro proceso
      if (this.isCallSessionLive(session) && !session.interrupted) {
        session.agentSpeaking = false;
        // 🟢 REINICIAR TEMPORIZADOR DE SILENCIO: El agente terminó, ahora esperamos al usuario
        this.resetSilenceTimer(session);
      }
      session.interceptedResponseText = '';

      // 🔚 Colgar si se detectó la señal [END_CALL]
      if (
        this.isCallSessionLive(session) &&
        shouldHangup &&
        !session.interrupted
      ) {
        console.log(
          `🔚 [${session.callSid}] Señal [END_CALL] detectada. Terminando llamada de Twilio.`,
        );
        
        // Asegurarnos de que el audio se envíe a Twilio
        this.flushOutboundAudioRemainder(session);
        
        // Colgar la llamada real de Twilio y luego limpiar la sesión en el backend
        await this.hangupCall(session);
        this.cleanupSession(session.callSid);
      }
    } catch (err) {
      console.error(
        `❌ [${session.callSid}] Error generando respuesta LLM:`,
        err,
      );
    }
  }

  private connectToDeepgram(session: CallSession) {
    const ws = new WebSocket(this.deepgramUrl, {
      headers: {
        Authorization: `Token ${this.deepgramApiKey}`,
        'User-Agent': 'llamalo-ai/streams-gateway',
      },
    });

    session.voiceAgentSocket = ws;

    ws.on('open', () => {
      this.sendSettings(session);
      this.startKeepAlive(session);
    });

    ws.on('message', (data, isBinary) =>
      this.handleDeepgramMessage(session, data, Boolean(isBinary)),
    );

    ws.on('close', () => {
      session.readyForAudio = false;
      this.stopKeepAlive(session);
    });

    ws.on('error', (error) => {
      console.error(`❌ [${session.callSid}] Error en Deepgram WS:`, error);
      session.terminadoPor = 'error';
      this.systemLogsService.logError({
        type: LogType.CALL_FAILED,
        message: 'Error en Deepgram WS',
        reason: error.message,
        metadata: { callSid: session.callSid, userId: session.userId }
      });
    });
  }

  private sendSettings(session: CallSession) {
    const agent: Record<string, unknown> = {
      language: this.deepgramLanguage,
      listen: {
        provider: {
          type: this.deepgramListenProvider,
          model: this.deepgramListenModel,
          language: this.deepgramLanguage,
          smart_format: true,
          endpointing: 300, // Detectar silencio final más rápido (300ms) para mejorar latencia
        },
      },
      // DESHABILITADO: Deepgram Speak genera respuestas duplicadas sin contexto
      // El sistema usa SOLO ElevenLabs para TTS y OpenAI LLM para respuestas
      // Deepgram solo se usa para STT (transcripción de audio a texto)
      //
      // speak: {
      //   provider: {
      //     type: this.deepgramSpeakProvider,
      //     model: this.deepgramSpeakModel,
      //   },
      // },
    };

    // DESHABILITADO: Deepgram Context activa respuestas automáticas sin contexto Shopify
    // El contexto se envía SOLO al LLM de OpenAI a través de enrichInstructionsWithShopify()
    // Deepgram solo transcribe, no genera respuestas propias
    //
    // const contextMessages =
    //   session.instructions?.trim().length > 0
    //     ? [
    //         {
    //           type: 'History',
    //           role: 'assistant',
    //           content: session.instructions,
    //         },
    //       ]
    //     : [];
    // if (contextMessages.length) {
    //   agent.context = { messages: contextMessages };
    // }

    // DESHABILITADO: Deepgram Agent Think genera respuestas duplicadas/incorrectas
    // El sistema ahora usa SOLO el LLM configurado (OpenAI) que tiene acceso al contexto Shopify enriquecido
    // Deepgram solo transcribe, no genera respuestas propias
    //
    // const thinkConfig = this.buildThinkConfig();
    // if (thinkConfig) {
    //   agent.think = {
    //     ...thinkConfig,
    //     prompt: session.instructions,
    //   };
    // }

    console.log(
      `🔕 [${session.callSid}] Deepgram SOLO STT habilitado - speak/context/think DESHABILITADOS - usando LLM del sistema con contexto enriquecido`,
    );

    const payload = {
      type: 'Settings',
      audio: {
        input: { encoding: 'mulaw', sample_rate: 8000 },
        output: { encoding: 'mulaw', sample_rate: 8000, container: 'none' },
      },
      agent,
    };

    this.sendJsonToDeepgram(session, payload);
  }

  private buildThinkConfig():
    | {
        provider: { type: string; model: string; [key: string]: unknown };
        temperature?: number;
      }
    | undefined {
    if (!this.thinkProvider || !this.thinkModel) {
      return undefined;
    }

    return {
      provider: {
        type: this.thinkProvider,
        model: this.thinkModel,
      },
      temperature: this.thinkTemperature,
    };
  }

  private resolveInstructions(
    customParameters?: Record<string, string>,
  ): string {
    let instructions =
      customParameters?.instructions?.trim() || this.defaultInstructions;

    // Detectar si es el agente Xenon (Llamalo AI)
    const agentName = customParameters?.agentName?.toLowerCase() || '';
    const isXenon =
      agentName.includes('xenon') ||
      instructions.toLowerCase().includes('xenon');

    if (isXenon) {
      console.log(
        `🤖 [Streams] Xenon detectado, inyectando personalidad desde archivos...`,
      );
      const xenonPersona = this.readStaticFile(
        'src/knowledge/llamalo-ai/xenon-persona.md',
      );
      if (xenonPersona) {
        // Reemplazar la instrucción base (probablemente vacía o básica) por la personalidad completa
        instructions = xenonPersona;
      }

      // Cargar conocimiento estático corporativo
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
        // Adjuntarlo al final de las instrucciones si existe
        instructions += `\n\n--- CONOCIMIENTO DE EMPRESA ---\nUtiliza esta información para responder a las dudas del usuario:\n${companyKnowledge}\n--- FIN CONOCIMIENTO EMPRESA ---`;
      }
    }

    return instructions;
  }

  private resolveVoiceId(
    customParameters?: Record<string, string>,
  ): string | undefined {
    const customVoice =
      customParameters?.voiceId ||
      customParameters?.labsId || // Mantener compatibilidad con labsId
      customParameters?.voice_id ||
      customParameters?.agentVoiceId;
    const normalized = customVoice?.trim();
    if (normalized) {
      return normalized;
    }
    const envVoice = this.elevenLabsTtsVoiceId?.trim();
    return envVoice || undefined;
  }

  private resolveLanguage(customParameters?: Record<string, string>): string {
    const customLanguage = customParameters?.language?.trim();
    if (customLanguage) {
      return customLanguage;
    }
    return this.elevenLabsLanguage;
  }

  private resolveGreeting(
    customParameters?: Record<string, string>,
  ): string | undefined {
    if (!customParameters) return undefined;
    if (customParameters.greeting?.trim()) {
      return customParameters.greeting.trim().slice(0, 500);
    }
    if (customParameters.agentName?.trim()) {
      return `Hola, soy ${customParameters.agentName.trim()}. ¿En qué puedo ayudarte hoy?`;
    }
    return undefined;
  }

  private getVoiceParameter(
    customParameters: Record<string, string> | undefined,
    parameterName: string,
    defaultValue: number | boolean,
  ): number | boolean {
    if (!customParameters || !customParameters[parameterName]) {
      return defaultValue;
    }

    const value = customParameters[parameterName];

    // Convertir a número si el defaultValue es número
    if (typeof defaultValue === 'number') {
      const numValue = Number(value);
      return isNaN(numValue) ? defaultValue : numValue;
    }

    // Convertir a booleano si el defaultValue es booleano
    if (typeof defaultValue === 'boolean') {
      return value === 'true';
    }

    return defaultValue;
  }

  private forwardInboundAudio(callSid: string, msg: TwilioMediaIn) {
    const session = this.sessions.get(callSid);
    if (!session) {
      // Típico: media rezagada tras cleanupSession/stop; no spamear logs
      return;
    }

    if (!msg.media?.payload) {
      console.warn(`⚠️ [${callSid}] Media sin payload`);
      return;
    }

    // Aceptar tanto el track por defecto ("inbound") como el configurado en TwiML ("inbound_track")
    if (
      msg.media.track &&
      msg.media.track !== 'inbound' &&
      msg.media.track !== 'inbound_track'
    ) {
      return;
    }

    const chunk = Buffer.from(msg.media.payload, 'base64');

    if (!session.readyForAudio) {
      session.queuedAudio.push(chunk);
      if (session.queuedAudio.length > this.maxBufferedChunks) {
        session.queuedAudio.shift();
      }
      return;
    }

    // No interrumpir aquí basado solo en flujo de audio crudo (eco del agente dispararía barge-in)
    // Dejar que el proveedor STT (Deepgram) determine SpeechStarted/UserStartedSpeaking
    /*
    if (!session.userSpeakingStartTime) {
      session.userSpeakingStartTime = Date.now();
    }
    if (session.agentSpeaking && !session.interrupted) {
      session.interrupted = true;
      if (session.ttsCancelStream) {
        session.ttsCancelStream();
      }
    }
    */
    if (this.usingElevenLabs(session)) {
      this.sendAudioChunkToElevenLabs(session, chunk);
    } else {
      this.sendAudioChunkToDeepgram(session, chunk);
    }
  }

  private sendAudioChunkToDeepgram(session: CallSession, chunk: Buffer) {
    const socket = session.voiceAgentSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(chunk, { binary: true });
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a Deepgram:`,
        error,
      );
    }
  }

  private sendAudioChunkToElevenLabs(session: CallSession, chunk: Buffer) {
    const socket = session.sttSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(chunk, { binary: true });
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a ElevenLabs STT:`,
        error,
      );
    }
  }

  private flushQueuedAudio(session: CallSession) {
    if (!session.queuedAudio.length) return;
    const buffered = [...session.queuedAudio];
    session.queuedAudio.length = 0;
    buffered.forEach((chunk) => {
      if (this.usingElevenLabs(session)) {
        this.sendAudioChunkToElevenLabs(session, chunk);
      } else {
        this.sendAudioChunkToDeepgram(session, chunk);
      }
    });
  }

  /**
   * Convierte PCM 16-bit 16kHz a μ-law 8-bit 8kHz
   */
  private convertPcm16kToUlaw8k(pcm16k: Buffer): Buffer {
    // Downsample: tomar cada segunda muestra (16kHz -> 8kHz)
    // Cada muestra PCM es 2 bytes (16-bit)
    const samples16k = pcm16k.length / 2;
    const samples8k = Math.floor(samples16k / 2);
    const ulaw8k = Buffer.alloc(samples8k);

    for (let i = 0; i < samples8k; i++) {
      // Tomar cada segunda muestra para downsampling
      const sampleIndex = i * 2;
      if (sampleIndex * 2 + 1 >= pcm16k.length) break;

      // Leer muestra PCM 16-bit signed (little-endian)
      const pcmSample = pcm16k.readInt16LE(sampleIndex * 2);

      // Convertir a μ-law usando el algoritmo estándar
      const sign = pcmSample < 0 ? 0x80 : 0x00;
      let magnitude = Math.abs(pcmSample);
      if (magnitude > 32635) magnitude = 32635; // Clamp

      // Algoritmo μ-law (μ = 255)
      let exponent = 0;
      let expMask = 0x4000;
      while (magnitude < expMask && exponent < 8) {
        exponent++;
        expMask >>= 1;
      }

      const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
      const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;

      ulaw8k[i] = ulawByte;
    }

    return ulaw8k;
  }

  private async relayAudioToTwilio(
    session: CallSession,
    chunk: Buffer,
    ttsFormat?: string,
  ) {
    // Si hay una interrupción activa y se permiten interrupciones, no reenviar audio
    if (session.allowInterruptions !== false && session.interrupted) {
      console.log(
        `⏸️ [${session.callSid}] Audio bloqueado por interrupción (chunk size: ${chunk.length})`,
      );
      return;
    }

    if (!session.streamSid) {
      console.warn(
        `⚠️ [${session.callSid}] No hay streamSid para enviar audio a Twilio`,
      );
      return;
    }

    try {
      // ElevenLabs con 'ulaw_8000' puede añadir una pequeña cabecera WAV al principio del primer chunk del stream.
      // La quitamos por seguridad para asegurar que a Twilio solo le llegue payload de audio crudo.
      const { payload } = this.stripWavHeaderIfPresent(chunk);

      // Enviamos directamente a la cola de salida sin conversiones costosas (Passthrough directo).
      this.enqueueOutboundFrames(session, payload);
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a Twilio:`,
        error,
      );
    }
  }

  private normalizeTtsFormat(format: string): 'ulaw_8000' | 'pcm_16000' {
    return format === 'pcm_16000' ? 'pcm_16000' : 'ulaw_8000';
  }

  private enqueueOutboundFrames(session: CallSession, audioChunk: Buffer) {
    if (!audioChunk || audioChunk.length === 0) return;

    // Empaquetador de frames (Frame Packer): Acumulamos el audio entrante
    session.outboundBuffer = session.outboundBuffer
      ? Buffer.concat([session.outboundBuffer, audioChunk])
      : audioChunk;

    // Twilio espera exactamente 160 bytes por frame (20ms de audio ulaw 8000Hz)
    const FRAME_SIZE = 160;
    const FRAME_DURATION_MS = 20;

    // Mientras tengamos suficientes bytes para formar un frame completo, lo enviamos.
    // Al no usar temporizadores (setTimeout), eliminamos el jitter introducido por Node.js.
    while (session.outboundBuffer.length >= FRAME_SIZE) {
      const frame = session.outboundBuffer.subarray(0, FRAME_SIZE);
      session.outboundBuffer = session.outboundBuffer.subarray(FRAME_SIZE);

      try {
        session.client.send(
          JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: {
              payload: frame.toString('base64'),
              track: 'outbound',
            },
          }),
        );

        // Calcular el tiempo estimado en que este audio terminará de reproducirse
        const now = Date.now();
        if (
          !session.expectedAudioEndTime ||
          session.expectedAudioEndTime < now
        ) {
          session.expectedAudioEndTime = now + FRAME_DURATION_MS;
        } else {
          session.expectedAudioEndTime += FRAME_DURATION_MS;
        }
      } catch (err) {
        console.error(
          `❌ [${session.callSid}] Error enviando frame a Twilio:`,
          err,
        );
      }
    }
  }

  /**
   * Envía el resto de audio que no alcanzó un frame de 160 bytes (Twilio exige frames completos).
   * Sin esto se pierde el final de cada locución (muy notable en el saludo).
   */
  private flushOutboundAudioRemainder(session: CallSession) {
    if (!session.streamSid || !session.client) {
      return;
    }
    const FRAME_SIZE = 160;
    const FRAME_DURATION_MS = 20;
    /** Silencio μ-law (aprox. línea en reposo) para rellenar el último frame */
    const SILENCE_ULAW = 0xff;

    let buf = session.outboundBuffer?.length
      ? session.outboundBuffer
      : Buffer.alloc(0);
    if (buf.length === 0) {
      return;
    }

    while (buf.length > 0) {
      let frame: Buffer;
      if (buf.length >= FRAME_SIZE) {
        frame = buf.subarray(0, FRAME_SIZE);
        buf = buf.subarray(FRAME_SIZE);
      } else {
        const padded = Buffer.alloc(FRAME_SIZE, SILENCE_ULAW);
        buf.copy(padded, 0);
        frame = padded;
        buf = Buffer.alloc(0);
      }
      try {
        session.client.send(
          JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: {
              payload: frame.toString('base64'),
              track: 'outbound',
            },
          }),
        );
        const now = Date.now();
        if (
          !session.expectedAudioEndTime ||
          session.expectedAudioEndTime < now
        ) {
          session.expectedAudioEndTime = now + FRAME_DURATION_MS;
        } else {
          session.expectedAudioEndTime += FRAME_DURATION_MS;
        }
      } catch (err) {
        console.error(
          `❌ [${session.callSid}] Error enviando frame final (flush) a Twilio:`,
          err,
        );
        break;
      }
    }
    session.outboundBuffer = buf;
  }

  /**
   * ElevenLabs puede devolver WAV con cabecera aun cuando se solicita μ-law.
   * Si detectamos 'RIFF....WAVEfmt ' y chunk 'data', devolvemos solo el payload de datos.
   */
  private stripWavHeaderIfPresent(buffer: Buffer): {
    payload: Buffer;
    stripped: boolean;
  } {
    if (buffer.length < 16) return { payload: buffer, stripped: false };
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
      return { payload: buffer, stripped: false };
    }
    // Recorre chunks RIFF hasta encontrar 'data'
    let offset = 12; // saltar 'RIFF' + size + 'WAVE'
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + chunkSize;
      if (chunkId === 'data' && dataStart <= buffer.length) {
        const end = Math.min(dataEnd, buffer.length);
        return { payload: buffer.subarray(dataStart, end), stripped: true };
      }
      offset = dataStart + chunkSize;
    }
    return { payload: buffer, stripped: false };
  }

  private isMp3Header(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;
    // ID3 tag
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true;
    // MPEG frame sync 0xFF 0xFB / 0xF3 / 0xF2
    const b0 = buffer[0];
    const b1 = buffer[1];
    if (b0 === 0xff && (b1 === 0xfb || b1 === 0xf3 || b1 === 0xf2)) {
      return true;
    }
    return false;
  }

  private async decodeMp3AndRelay(
    session: CallSession,
    mp3Buffer: Buffer,
  ): Promise<void> {
    const pcm16k = await this.decodeMp3ToPcm16k(mp3Buffer);
    const ulaw = this.convertPcm16kToUlaw8k(pcm16k);
    await this.relayAudioToTwilio(session, ulaw, 'ulaw_8000');
  }

  private async decodeMp3ToPcm16k(buffer: Buffer): Promise<Buffer> {
    const ffmpegBinary = (ffmpegStaticPath as string) || '';
    if (!ffmpegBinary) {
      throw new Error('ffmpeg-static no disponible para decodificar MP3');
    }
    return new Promise<Buffer>((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'mp3',
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        'pipe:1',
      ];

      const proc = spawn(ffmpegBinary, args);
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];

      proc.stdout.on('data', (data) => chunks.push(data as Buffer));
      proc.stderr.on('data', (data) => errors.push(data as Buffer));
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(
            new Error(
              `ffmpeg salió con código ${code}: ${Buffer.concat(errors).toString('utf-8')}`,
            ),
          );
        }
        resolve(Buffer.concat(chunks));
      });

      proc.stdin.on('error', (err) => reject(err));
      proc.stdin.end(buffer);
    });
  }

  private handleDeepgramMessage(
    session: CallSession,
    data: RawData,
    isBinary: boolean,
  ) {
    if (isBinary) {
      // Ignorar audio TTS binario de Deepgram - usaremos TTS externo
      return;
    }

    this.handleDeepgramJsonMessage(session, this.rawDataToString(data));
  }

  private handleDeepgramJsonMessage(session: CallSession, raw: string) {
    try {
      const message = JSON.parse(raw) as DeepgramJsonEvent;
      const type = message.type;

      if (!type) {
        console.warn(`⚠️ [${session.callSid}] Evento sin tipo`, message);
        return;
      }

      switch (type) {
        case 'Welcome':
          session.deepgramRequestId = this.asText(message.request_id);
          break;
        case 'SettingsApplied':
          session.readyForAudio = true;
          this.flushQueuedAudio(session);
          this.maybeSendPendingGreeting(session);
          break;
        case 'AgentStartedSpeaking':
          // IGNORAMOS el AgentStartedSpeaking de Deepgram porque usamos nuestro propio LLM y ElevenLabs.
          // session.agentSpeaking = true; se maneja al recibir el primer token de OpenAI.
          break;
        case 'AgentAudioDone':
          // IGNORAMOS el AgentAudioDone de Deepgram porque no sabemos cuándo termina el TTS externo.
          // session.agentSpeaking = false; se maneja al terminar el stream de ElevenLabs.
          break;
        case 'UserStartedSpeaking':
          session.userSpeakingStartTime = Date.now();

          // Durante el saludo inicial no permitimos barge-in (eco/ruido cortaba el TTS)
          if (session.allowInterruptions === false) {
            break;
          }

          // En Deepgram V1 Listen puro o si estamos usando Agent, UserStartedSpeaking puede saltar por ruido
          // Solo limpiar si el agente realmente estaba hablando y reproduciendo audio.
          // Si el LLM está pensando y aún no ha reproducido nada, ignoramos esto para no auto-cortar la llamada por eco.

          // 🔥 FIX: Protección contra Barge-in temprano (eco inicial o ruido de línea)
          // Ignorar interrupciones durante los primeros 1500ms desde que el agente empezó a hablar (reducido para mejor respuesta)
          if (
            session.lastAgentStartSpeakingTime &&
            Date.now() - session.lastAgentStartSpeakingTime < 1500
          ) {
            // console.log(`ℹ️ [${session.callSid}] Barge-in ignorado (<1500ms)`);
            break;
          }

          // Verificamos si el agente está hablando o si hay audio encolado reproduciéndose en Twilio
          const isPlayingAudio =
            session.expectedAudioEndTime &&
            session.expectedAudioEndTime > Date.now();

          if (
            (session.agentSpeaking || isPlayingAudio) &&
            !session.interrupted
          ) {
            console.log(
              `🛑 [${session.callSid}] Barge-in: usuario interrumpió`,
            );
            session.interrupted = true;
            session.agentSpeaking = false;
            session.expectedAudioEndTime = 0; // Resetear tiempo estimado
            session.silenceInterventions = 0;
            // Al detectar una interrupción, también consideramos que el usuario "ha hablado", 
            // así que limpiamos la bandera de silencio si existiera para que no se despida después.
            if (session.terminadoPor === 'silencio') {
              session.terminadoPor = undefined;
            }

            // Cancelar cualquier TTS en progreso
            if (session.ttsCancelStream) {
              session.ttsCancelStream();
              session.ttsCancelStream = undefined;
            }

            // Cancelar cualquier request TTS pendiente
            if (session.currentTTSRequest) {
              session.currentTTSRequest = undefined;
            }

            // Limpiar texto interceptado
            session.interceptedResponseText = '';

            // Limpiar buffer de audio saliente
            session.outboundBuffer = Buffer.alloc(0);

            // 🔥 FIX CRÍTICO: Vaciar el buffer interno de Twilio para silencio inmediato
            if (session.streamSid) {
              session.client.send(
                JSON.stringify({
                  event: 'clear',
                  streamSid: session.streamSid,
                }),
              );
            }

            // Al interrumpir, reiniciamos la espera porque el usuario ha tomado el turno
            this.resetSilenceTimer(session);
          }
          break;
        case 'AgentThinking':
          // Silenciar este evento para reducir ruido
          break;
        case 'ConversationText': {
          const text = this.extractTextFromConversationText(message);
          const role = this.extractRoleFromConversationText(message);

          if (text) {
            if (role === 'user') {
              // Eco del TTS del saludo puede llegar como "usuario" y disparar el LLM + clear
              if (session.allowInterruptions === false) {
                break;
              }
              void this.handleFinalTranscript(session, text);
              this.resetSilenceTimer(session); // Reiniciar temporizador de silencio
            } else {
              // Ignorar ConversationText de Deepgram cuando role=assistant (eco/TTS)
              // No renovamos lastAgentStartSpeakingTime aquí para no bloquear el barge-in durante toda la locución.
              // La protección inicial de 1500ms ya se activó al empezar el LLM/Intent.
            }
          } else {
            console.warn(
              `⚠️ [${session.callSid}] ConversationText sin texto extraíble`,
            );
          }
          break;
        }
        case 'Response':
        case 'AgentResponse': {
          // Intentar interceptar texto de eventos Response/AgentResponse si existen
          const text = this.extractTextFromResponse(message);
          if (text && session.agentSpeaking) {
            if (session.allowInterruptions === false) {
              break;
            }
            session.interceptedResponseText += text;
            void this.streamTTSFromText(session, text);
          }
          break;
        }
        case 'Warning': {
          const warnCode = this.asText(message.code);
          const warnDesc = this.asText(message.description);
          console.warn(
            `⚠️ [${session.callSid}] Deepgram warning: ${warnCode} ${warnDesc}`.trim(),
          );
          break;
        }
        case 'Error': {
          const errCode = this.asText(message.code);
          const errDesc = this.asText(message.description);
          console.error(
            `❌ [${session.callSid}] Deepgram error: ${errCode} ${errDesc}`.trim(),
          );
          break;
        }
        case 'FunctionCallRequest':
          console.warn(
            `⚠️ [${session.callSid}] FunctionCallRequest no soportado (usando contexto de pedidos en lugar de function calling)`,
          );
          break;
        case 'History':
          // Silenciar este evento
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error interpretando mensaje Deepgram:`,
        error,
      );
    }
  }

  private extractTextFromConversationText(message: DeepgramJsonEvent): string {
    // Intentar extraer texto de diferentes campos posibles
    if (message.text && typeof message.text === 'string') {
      return message.text;
    }
    if (message.content && typeof message.content === 'string') {
      return message.content;
    }
    if (message.message && typeof message.message === 'string') {
      return message.message;
    }
    // Si es un array de mensajes, extraer texto de cada uno
    if (Array.isArray(message.messages)) {
      return message.messages
        .map((msg: unknown) => {
          if (typeof msg === 'object' && msg !== null) {
            const msgObj = msg as Record<string, unknown>;
            return (
              (msgObj.text as string) ||
              (msgObj.content as string) ||
              (msgObj.message as string) ||
              ''
            );
          }
          return '';
        })
        .join(' ');
    }
    // Intentar extraer de objetos anidados
    if (message.data && typeof message.data === 'object') {
      const data = message.data as Record<string, unknown>;
      if (data.text && typeof data.text === 'string') {
        return data.text;
      }
      if (data.content && typeof data.content === 'string') {
        return data.content;
      }
    }
    return '';
  }

  private extractRoleFromConversationText(
    message: DeepgramJsonEvent,
  ): string | null {
    // Intentar extraer el rol del mensaje para filtrar solo respuestas del agente
    if (message.role && typeof message.role === 'string') {
      return message.role.toLowerCase();
    }
    if (message.speaker && typeof message.speaker === 'string') {
      return message.speaker.toLowerCase();
    }
    if (message.data && typeof message.data === 'object') {
      const data = message.data as Record<string, unknown>;
      if (data.role && typeof data.role === 'string') {
        return data.role.toLowerCase();
      }
    }
    return null;
  }

  private extractTextFromResponse(message: DeepgramJsonEvent): string {
    // Extraer texto de eventos Response/AgentResponse
    if (message.text && typeof message.text === 'string') {
      return message.text;
    }
    if (message.content && typeof message.content === 'string') {
      return message.content;
    }
    if (message.response && typeof message.response === 'string') {
      return message.response;
    }
    if (message.data && typeof message.data === 'object') {
      const data = message.data as Record<string, unknown>;
      if (data.text && typeof data.text === 'string') {
        return data.text;
      }
      if (data.content && typeof data.content === 'string') {
        return data.content;
      }
    }
    return '';
  }

  private async streamTTSFromText(
    session: CallSession,
    text: string,
    options?: { recordAssistantUtteranceOnComplete?: string },
  ) {
    let processedText = text;
    let shouldHangup = false;

    // Normalizar cualquier variante de "End Call" al token [END_CALL] (sin anclaje $)
    processedText = processedText.replace(
      /\[?END[\s_]*CALL\]?/gi,
      '[END_CALL]',
    );

    if (processedText.includes('[END_CALL]')) {
      console.log(
        `🔚 [${session.callSid}] Señal [END_CALL] (o fallback "End Call") detectada en TTS manual.`,
      );
      shouldHangup = true;
      processedText = processedText.replace(/\[?END[\s_]*CALL\]?/gi, '').trim();
    }

    if (session.interrupted || !processedText.trim()) {
      console.log(
        `⏸️ TTS cancelado (interrupted: ${session.interrupted}, text vacío: ${!processedText.trim()})`,
      );
      return;
    }

    // Evitar solapes de TTS
    if (session.currentTTSRequest) {
      try {
        console.log(`⏳ Esperando TTS anterior antes de procesar nuevo texto`);
        await session.currentTTSRequest;
      } catch (err) {
        console.warn(
          `⚠️ [${session.callSid}] Error en TTS anterior ignorado:`,
          err,
        );
      }
    }

    // Si es el primer TTS (greeting), deshabilitar interrupciones
    const wasGreetingPending = session.greetingPlaybackDone !== true;
    if (wasGreetingPending) {
      session.allowInterruptions = false;
    }
    // Asegurar que no haya marca de interrupción previa antes de iniciar TTS
    session.interrupted = false;

    session.currentTTSRequest = this.streamElevenLabsTTS(session, processedText)
      .then(async () => {
        const toRecord = options?.recordAssistantUtteranceOnComplete?.trim();
        if (
          toRecord &&
          !session.interrupted &&
          !session.initialGreetingWrittenToHistory
        ) {
          session.history.push({ role: 'assistant', content: toRecord });
          session.initialGreetingWrittenToHistory = true;
          console.log(
            `📝 [${session.callSid}] Saludo inicial copiado al historial del LLM para evitar re-presentaciones.`,
          );
        }
        if (shouldHangup && !session.interrupted) {
          console.log(
            `🔚 [${session.callSid}] Colgando tras completar TTS con [END_CALL]`,
          );
          await this.hangupCall(session);
        }
      })
      .catch((error) => {
        if (!session.interrupted) {
          console.error(
            `❌ [${session.callSid}] Error en TTS para texto:`,
            error,
          );
          if (error instanceof Error) {
            console.error(`❌ [${session.callSid}] Error stack:`, error.stack);
          }
        } else {
          console.log(`⏸️ [${session.callSid}] TTS cancelado por interrupción`);
        }
      })
      .finally(() => {
        // console.log(`🏁 Finalizando TTS request`);
        session.currentTTSRequest = undefined;
        if (wasGreetingPending) {
          // El stream de ElevenLabs termina antes que Twilio vacíe la cola; si reactivamos
          // allowInterruptions al instante, UserStartedSpeaking + clear corta el final del saludo.
          if (session.pendingGreetingReleaseTimer) {
            clearTimeout(session.pendingGreetingReleaseTimer);
            session.pendingGreetingReleaseTimer = undefined;
          }
          const marginMs = 450;
          const playEnd = session.expectedAudioEndTime ?? Date.now();
          const delay = Math.max(marginMs, playEnd - Date.now() + marginMs);
          session.pendingGreetingReleaseTimer = setTimeout(() => {
            session.pendingGreetingReleaseTimer = undefined;
            if (!this.isCallSessionLive(session)) {
              return;
            }
            session.allowInterruptions = true;
            session.greetingPlaybackDone = true;
          }, delay);
        }
      });
    await session.currentTTSRequest;
  }

  /**
   * Obtiene o crea una conexión WebSocket persistente con ElevenLabs para reducir latencia.
   */
  private async streamElevenLabsTTS(
    session: CallSession,
    text: string,
  ): Promise<void> {
    if (!this.elevenLabsApiKey) {
      console.error(
        `❌ [${session.callSid}] ELEVENLABS_API_KEY no configurado para TTS.`,
      );
      return;
    }

    const voiceId = session.voiceId || this.elevenLabsTtsVoiceId;
    if (!voiceId) {
      console.error(
        `❌ [${session.callSid}] No se pudo resolver voiceId/labsId (customParameters ni entorno).`,
      );
      return;
    }

    // Log del voiceId que se está usando para TTS
    // console.log(`🎙️ [${session.callSid}] Usando Voice ID para TTS: ${voiceId}`);

    // Obtener parámetros de voz personalizados del agente o usar valores del entorno como fallback
    const voiceStability = this.getVoiceParameter(
      session.customParameters,
      'voiceStability',
      this.elevenLabsTtsStability,
    );
    const voiceSimilarity = this.getVoiceParameter(
      session.customParameters,
      'voiceSimilarity',
      this.elevenLabsTtsSimilarity,
    );
    const voiceStyle = this.getVoiceParameter(
      session.customParameters,
      'voiceStyle',
      this.elevenLabsTtsStyle,
    );
    const voiceBoost = this.getVoiceParameter(
      session.customParameters,
      'voiceBoost',
      this.elevenLabsTtsSpeakerBoost,
    );
    const voiceSpeed = this.getVoiceParameter(
      session.customParameters,
      'voiceSpeed',
      this.elevenLabsTtsVoiceSpeed,
    );

    // console.log(`🎛️ [${session.callSid}] Parámetros de voz finales:`, {
    //   stability: voiceStability,
    //   similarity: voiceSimilarity,
    //   style: voiceStyle,
    //   boost: voiceBoost,
    //   speed: voiceSpeed,
    //   customParameters: session.customParameters,
    // });

    const normalizedFormat = this.normalizeTtsFormat(
      this.elevenLabsTtsOutputFormat,
    );
    // Añadimos optimize_streaming_latency=4 para máxima velocidad con Flash v2.5
    const url = `${this.elevenLabsBaseUrl}/text-to-speech/${voiceId}/stream?output_format=${encodeURIComponent(normalizedFormat)}&optimize_streaming_latency=4`;

    try {
      session.agentSpeaking = true;
      // Ventana anti-eco del saludo: el LLM ya pone lastAgentStartSpeakingTime en el primer token;
      // el TTS del saludo no pasa por ahí, así que marcamos aquí solo cuando las interrupciones están bloqueadas.
      if (session.allowInterruptions === false) {
        session.lastAgentStartSpeakingTime = Date.now();
      }

      // console.log(
      //   `📋 Payload streamElevenLabsTTS: ${JSON.stringify({
      //     text: text.trim().substring(0, 50) + (text.length > 50 ? '...' : ''),
      //     model_id: this.elevenLabsTtsModelId,
      //     output_format: normalizedFormat,
      //   })}`,
      // );

      const response = await axios.post(
        url,
        {
          text: text.trim(),
          model_id: this.elevenLabsTtsModelId,
          voice_settings: {
            stability: voiceStability,
            similarity_boost: voiceSimilarity,
            style: voiceStyle,
            use_speaker_boost: voiceBoost,
            voice_speed: voiceSpeed,
          },
          // output_format va en la query; en el body mantenemos solo para trazabilidad
          output_format: normalizedFormat,
        },
        {
          headers: {
            'xi-api-key': this.elevenLabsApiKey,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 10000, // Timeout reducido a 10 segundos
          // Permitimos 4xx para poder leer el cuerpo del error
          validateStatus: (status) => status < 500,
        },
      );

      // Validar status code antes de procesar el stream (para 4xx leer el cuerpo)
      if (response.status >= 400) {
        const chunks: Buffer[] = [];
        for await (const chunk of response.data as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        const errorBody = Buffer.concat(chunks).toString('utf-8');
        let errorMessage = `ElevenLabs API error ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage =
            (errorJson.detail && errorJson.detail.message) ||
            errorJson.message ||
            errorBody ||
            errorMessage;
          console.error(
            `❌ [${session.callSid}] ElevenLabs error details:`,
            JSON.stringify(errorJson, null, 2),
          );
        } catch (parseErr) {
          console.warn(
            `⚠️ [${session.callSid}] Error parseando respuesta ElevenLabs:`,
            parseErr,
          );
          errorMessage = errorBody || errorMessage;
        }
        throw new Error(`ElevenLabs TTS error: ${errorMessage}`);
      }

      const audioStream = response.data as Readable;

      if (!audioStream) {
        console.error(
          `❌ [${session.callSid}] audioStream es null o undefined`,
        );
        throw new Error('audioStream es null o undefined');
      }

      // Forzar el stream a modo flowing para que emita eventos 'data'
      audioStream.resume();

      const cancel = () => {
        session.agentSpeaking = false;
        audioStream.destroy();
      };
      session.ttsCancelStream = cancel;

      await new Promise<void>((resolve, reject) => {
        // Timeout de seguridad (30 segundos)
        const timeout = setTimeout(() => {
          console.error(`⏱️ Timeout esperando stream ElevenLabs TTS`);
          cancel();
          reject(new Error('Timeout esperando stream ElevenLabs TTS'));
        }, 30000);

        let firstChunkChecked = false;
        let mp3Chunks: Buffer[] | null = null;
        const contentType = response.headers['content-type'] || '';
        const forceMp3Buffering = contentType
          .toLowerCase()
          .includes('audio/mpeg');

        let streamFinalized = false;
        let settled = false;

        const settleOk = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };

        const finalizeStream = () => {
          if (streamFinalized) return;
          streamFinalized = true;
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;

          if (mp3Chunks && mp3Chunks.length) {
            void this.decodeMp3AndRelay(session, Buffer.concat(mp3Chunks))
              .then(() => {
                this.flushOutboundAudioRemainder(session);
                settleOk();
              })
              .catch((err) => {
                console.error(
                  `❌ [${session.callSid}] Error decodificando MP3 de ElevenLabs:`,
                  err,
                );
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  reject(err instanceof Error ? err : new Error(String(err)));
                }
              });
          } else {
            this.flushOutboundAudioRemainder(session);
            settleOk();
          }
        };

        audioStream.on('data', (chunk: Buffer) => {
          if (session.allowInterruptions !== false && session.interrupted) {
            console.log(
              `🛑 [${session.callSid}] TTS interrumpido, cancelando stream`,
            );
            clearTimeout(timeout);
            cancel();
            return;
          }

          // Si el content-type ya dice MP3, bufferizar todo y decodificar al final
          if (forceMp3Buffering) {
            if (!mp3Chunks) mp3Chunks = [];
            mp3Chunks.push(Buffer.from(chunk));
            return;
          }

          // Si el primer chunk (o alguno) muestra cabecera MP3, bufferizar todo y decodificar al final
          if (!firstChunkChecked) {
            firstChunkChecked = true;
            const isMp3 = this.isMp3Header(chunk);
            if (isMp3) {
              console.error(
                `❌ [${session.callSid}] ElevenLabs devolvió MP3/ID3 pese a pedir ${normalizedFormat}; decodificando localmente`,
              );
              mp3Chunks = [];
              mp3Chunks.push(Buffer.from(chunk));
              return;
            }
          }

          void this.relayAudioToTwilio(
            session,
            Buffer.from(chunk),
            normalizedFormat,
          ).catch((err) => {
            console.error(
              `❌ [${session.callSid}] Error enviando chunk TTS a Twilio:`,
              err,
            );
            clearTimeout(timeout);
            cancel();
            if (!settled) {
              settled = true;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });
        audioStream.on('end', finalizeStream);
        audioStream.on('close', finalizeStream);
        audioStream.on('error', (err) => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          console.error(
            `❌ [${session.callSid}] Error en stream ElevenLabs TTS:`,
            err,
          );
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      });
    } catch (error) {
      session.ttsCancelStream = undefined;
      session.agentSpeaking = false;

      // Loggear SIEMPRE para debugging, incluso si está interrumpido
      console.error(
        `❌ [${session.callSid}] Error en ElevenLabs TTS (interrupted=${session.interrupted}):`,
        error,
      );

      if (error instanceof Error) {
        console.error(
          `❌ [${session.callSid}] Error message: ${error.message}`,
        );
        console.error(`❌ [${session.callSid}] Error stack: ${error.stack}`);

        if ('response' in error) {
          const axiosError = error as any;
          console.error(
            `❌ [${session.callSid}] Response status: ${axiosError.response?.status}`,
          );
          console.error(
            `❌ [${session.callSid}] Response data:`,
            JSON.stringify(axiosError.response?.data).substring(0, 500),
          );
        }
      }

      // Re-lanzar el error si no está interrumpido para que se capture en streamTTSFromText
      if (!session.interrupted) {
        throw error;
      }
    } finally {
      if (!session.interrupted) {
        session.agentSpeaking = false;
        // console.log(
        //   `✅ TTS ElevenLabs completado en ${Date.now() - (session.userSpeakingStartTime || Date.now())}ms`,
        // );
      }
    }
  }

  private maybeSendPendingGreeting(session: CallSession) {
    if (!session.pendingGreeting || session.greetingSent) {
      return;
    }

    const greeting = session.pendingGreeting;

    // console.log(
    //   `👋 Reproduciendo greeting con ElevenLabs TTS: "${greeting.substring(0, 50)}${greeting.length > 50 ? '...' : ''}"`,
    // );
    session.greetingSent = true;
    // Antes de que streamTTSFromText corra (y espere TTS previo), ya bloqueamos barge-in:
    // reduce la ventana donde Deepgram/STT puede disparar clear durante el saludo.
    session.allowInterruptions = false;
    session.lastAgentStartSpeakingTime = Date.now();
    void this.streamTTSFromText(session, greeting, {
      recordAssistantUtteranceOnComplete: greeting,
    }).catch((error) => {
      session.greetingSent = false;
      if (session.pendingGreetingReleaseTimer) {
        clearTimeout(session.pendingGreetingReleaseTimer);
        session.pendingGreetingReleaseTimer = undefined;
      }
      session.allowInterruptions = true;
      console.error(
        `❌ [${session.callSid}] Error reproduciendo greeting con ElevenLabs TTS:`,
        error,
      );
    });
  }

  private sendJsonToDeepgram(session: CallSession, payload: unknown) {
    const socket = session.voiceAgentSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando mensaje a Deepgram:`,
        error,
      );
    }
  }

  private startKeepAlive(session: CallSession) {
    if (this.keepAliveIntervalMs <= 0) return;
    this.stopKeepAlive(session);
    session.keepAliveTimer = setInterval(() => {
      this.sendJsonToDeepgram(session, { type: 'KeepAlive' });
    }, this.keepAliveIntervalMs);
  }

  // Reinicia el temporizador de silencio del usuario
  private resetSilenceTimer(session: CallSession) {
    if (session.silenceTimeout) {
      clearTimeout(session.silenceTimeout);
    }

    const PROMPT_TIMEOUT_MS = Number(process.env.SILENCE_PROMPT_TIMEOUT_MS) || 15 * 1000; // 15s para primera intervención
    const HANGUP_TIMEOUT_MS = Number(process.env.SILENCE_HANGUP_TIMEOUT_MS) || 30 * 1000; // 30s adicionales antes de colgar

    const nextTimeoutMs = (session.silenceInterventions ?? 0) >= 1 ? HANGUP_TIMEOUT_MS : PROMPT_TIMEOUT_MS;

    session.silenceTimeout = setTimeout(async () => {
      session.silenceTimeout = undefined;
      const stillActive = this.sessions.get(session.callSid);
      if (stillActive !== session) {
        // Llamada ya colgada / sesión sustituida: evitar intervención fantasma
        return;
      }

      const now = Date.now();
      // No intervenir si el agente aún está generando/reproduciendo audio (el usuario puede estar escuchando)
      if (
        session.currentTTSRequest ||
        session.agentSpeaking ||
        (session.expectedAudioEndTime &&
          session.expectedAudioEndTime > now + 400)
      ) {
        // En lugar de reiniciar para otros Xs, el temporizador vuelve a esperar el ciclo completo 
        // ya que el audio acaba de terminar o sigue reproduciéndose
        this.resetSilenceTimer(session);
        return;
      }

      session.silenceInterventions = (session.silenceInterventions || 0) + 1;

      console.warn(
        `⏳ [${session.callSid}] Silencio detectado por ${nextTimeoutMs / 1000} segundos. Intervención #${session.silenceInterventions}.`,
      );

      if (session.silenceInterventions === 1) {
        // Marcar que la causa probable de finalización es silencio del cliente
        session.terminadoPor = 'silencio';

        // Simular una instrucción de sistema para activar la respuesta del LLM
        const silenceInstruction =
          '(INSTRUCCIÓN DE SISTEMA: El usuario lleva un rato en silencio. Haz una pregunta muy breve y natural para saber si sigue ahí o necesita algo más. NUNCA menciones la palabra "silencio" ni digas que se cortó la conexión.)';
        await this.handleFinalTranscript(session, silenceInstruction, 'system');
      } else {
        // Segunda vez, colgar directamente
        console.warn(`⏳ [${session.callSid}] Silencio prolongado repetido. Finalizando llamada.`);
        session.terminadoPor = 'silencio';
        const finalSilenceInstruction =
          '(INSTRUCCIÓN DE SISTEMA: El usuario sigue en silencio prologando. Despídete muy brevemente indicando que vas a finalizar la llamada, sin alarmarte, y añade [END_CALL] al final de tu frase para terminar.)';
        await this.handleFinalTranscript(session, finalSilenceInstruction, 'system');
      }
    }, nextTimeoutMs);
  }

  private stopSilenceTimer(session: CallSession) {
    if (session.silenceTimeout) {
      clearTimeout(session.silenceTimeout);
      session.silenceTimeout = undefined;
    }
  }

  private stopKeepAlive(session: CallSession) {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = undefined;
    }
  }

  private async hangupCall(session: CallSession) {
    try {
      session.hangupNonce = (session.hangupNonce ?? 0) + 1;
      const hangupGeneration = session.hangupNonce;
      console.log(`📞 [${session.callSid}] Iniciando colgado de llamada (gen ${hangupGeneration})`);

      // Esperar a que el audio pendiente se termine de reproducir
      const now = Date.now();
      if (session.expectedAudioEndTime && session.expectedAudioEndTime > now) {
        const timeToWait = session.expectedAudioEndTime - now + 2000; // 2000ms de margen adicional para asegurar reproducción completa
        console.log(
          `⏳ [${session.callSid}] Esperando ${timeToWait}ms para que termine de hablar el agente antes de colgar (now: ${now}, expectedEndTime: ${session.expectedAudioEndTime})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }

      if (!this.isCallSessionLive(session)) {
        return;
      }
      if (session.hangupNonce !== hangupGeneration) {
        console.log(
          `🔕 [${session.callSid}] Colgado cancelado: hubo actividad (usuario o nuevo colgado) durante la espera.`,
        );
        return;
      }

      // Marcar que la llamada fue terminada por el agente (END_CALL o silencio gestionado)
      if (!session.terminadoPor) {
        session.terminadoPor = 'agente';
      }

      // 1. Cerrar el media stream si existe
      if (session.streamSid) {
        session.client.send(
          JSON.stringify({
            event: 'stop',
            streamSid: session.streamSid,
          }),
        );
        console.log(`🔇 [${session.callSid}] Media stream cerrado`);
      }

      // 2. Colgar la llamada usando API REST de Twilio (credenciales del usuario)
      const accountSid = session.customParameters?.twilioSid;
      const authToken = session.customParameters?.twilioToken;

      if (!accountSid || !authToken) {
        console.warn(
          `⚠️ [${session.callSid}] Credenciales Twilio del usuario no disponibles para colgar llamada`,
        );
      } else {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${session.callSid}.json`;

        try {
          await axios.post(url, 'Status=completed', {
            auth: {
              username: accountSid,
              password: authToken,
            },
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          });

          console.log(
            `✅ [${session.callSid}] Llamada colgada exitosamente vía API Twilio del usuario`,
          );
        } catch (apiError) {
          console.error(
            `❌ [${session.callSid}] Error al colgar vía API Twilio: ${apiError instanceof Error ? apiError.message : 'Error desconocido'}`
          );
        }
      }

      // 3. Cerrar conexiones WebSocket
      if (
        session.voiceAgentSocket &&
        session.voiceAgentSocket.readyState === WebSocket.OPEN
      ) {
        session.voiceAgentSocket.close();
      }
      if (
        session.sttSocket &&
        session.sttSocket.readyState === WebSocket.OPEN
      ) {
        session.sttSocket.close();
      }

      console.log(`🏁 [${session.callSid}] Proceso de colgado completado`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error(`❌ [${session.callSid}] Error al colgar: ${errorMessage}`);
    }
  }

  private extractCustomParameters(
    params?: Record<string, unknown>,
  ): Record<string, string> | undefined {
    if (!params) return undefined;
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      normalized[key] =
        typeof value === 'string' ? value : JSON.stringify(value);
    }
    return Object.keys(normalized).length ? normalized : undefined;
  }

  private cleanupSession(callSid: string) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    // Calcular y loguear la media de latencia de la llamada (solo valores >= 0)
    const validLatencies =
      session.responseLatencies?.filter((v) => v >= 0) ?? [];
    if (validLatencies.length > 0) {
      const sum = validLatencies.reduce((acc, val) => acc + val, 0);
      const avg = Math.round(sum / validLatencies.length);
      console.log(
        `📊 [${callSid}] Resumen de Latencia de la Llamada: Media ${avg}ms en ${validLatencies.length} interacciones. (Tiempos: ${validLatencies.join('ms, ')}ms)`,
      );
    } else if (session.responseLatencies?.length) {
      console.log(
        `📊 [${callSid}] Resumen de Latencia: ${session.responseLatencies.length} interacciones sin latencias válidas.`,
      );
    } else {
      console.log(
        `📊 [${callSid}] Resumen de Latencia de la Llamada: No hubo interacciones registradas.`,
      );
    }

    this.stopKeepAlive(session);
    this.stopSilenceTimer(session); // Detener temporizador de silencio al limpiar sesión

    if (session.pendingGreetingReleaseTimer) {
      clearTimeout(session.pendingGreetingReleaseTimer);
      session.pendingGreetingReleaseTimer = undefined;
    }

    if (session.ttsCancelStream) {
      session.ttsCancelStream();
      session.ttsCancelStream = undefined;
    }

    if (
      session.voiceAgentSocket &&
      session.voiceAgentSocket.readyState === WebSocket.OPEN
    ) {
      session.voiceAgentSocket.close();
    }
    if (session.sttSocket && session.sttSocket.readyState === WebSocket.OPEN) {
      session.sttSocket.close();
    }

    // Guardar razón de finalización en Firestore si tenemos userId
    if (session.userId && session.customParameters?.twilioAccountId) {
      const duracionSegundos = session.callStartTime
        ? Math.round((Date.now() - session.callStartTime) / 1000)
        : 0;
      const motivo = session.terminadoPor ?? 'cliente';

      // 💾 Persistir la transcripción completa en Firestore para aprendizaje (Learning Pipeline)
      if (session.history && session.history.length > 0) {
        try {
          admin.firestore().collection('calls_logs').doc(session.callSid).set({
            callSid: session.callSid,
            userId: session.userId,
            twilioAccountId: session.customParameters.twilioAccountId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            duration: duracionSegundos,
            history: session.history,
            terminadoPor: motivo,
            agentName: session.customParameters?.agentName || 'Desconocido',
            callerPhone: session.callerPhone || null,
            processedForLearning: false, // Flag para el worker
          });
          console.log(`💾 [${callSid}] Historial de llamada persistido en calls_logs`);
        } catch (err) {
          console.error(`❌ [${callSid}] Error guardando log de la llamada:`, err);
        }
      }

      this.metricsService
        .saveCallTermination(
          session.userId,
          parseInt(session.customParameters.twilioAccountId),
          session.callSid,
          motivo,
          duracionSegundos,
        )
        .catch((err) =>
          console.error(
            `❌ [${callSid}] Error guardando finalización de llamada:`,
            err,
          ),
        );

      const startedAtMs =
        session.callStartTime ?? Date.now() - duracionSegundos * 1000;
      const toNumber =
        (session.customParameters?.to as string | undefined) ||
        (session.customParameters?.called as string | undefined) ||
        '';
      this.metricsService
        .saveRegisteredCall({
          userId: session.userId,
          twilioAccountId: parseInt(session.customParameters.twilioAccountId, 10),
          callSid: session.callSid,
          durationSeconds: duracionSegundos,
          direction: session.callDirection ?? 'inbound',
          from: session.callerPhone || '',
          to: toNumber,
          startedAtMs,
        })
        .catch((err) =>
          console.error(
            `❌ [${callSid}] Error guardando llamada registrada (métricas):`,
            err,
          ),
        );

      // Acumular métricas históricas en Firestore
      const paisPrefijo = session.callerPhone
        ? this.metricsService.extractCountryCodePublic(session.callerPhone)
        : null;
      this.metricsService
        .saveHistoricalMetrics(
          session.userId,
          duracionSegundos,
          session.callDirection ?? 'inbound',
          motivo,
          paisPrefijo,
        )
        .catch((err) =>
          console.error(
            `❌ [${callSid}] Error guardando métricas históricas:`,
            err,
          ),
        );
    }

    this.sessions.delete(callSid);
  }

  private rawDataToString(data: RawData): string {
    if (typeof data === 'string') {
      return data;
    }
    if (data instanceof Buffer) {
      return data.toString();
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString();
    }
    return Buffer.from(data as ArrayBuffer).toString();
  }

  private rawDataToBuffer(data: RawData): Buffer {
    if (data instanceof Buffer) {
      return data;
    }
    if (typeof data === 'string') {
      return Buffer.from(data);
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data);
    }
    return Buffer.from(data as ArrayBuffer);
  }

  private asText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return '';
  }

  /**
   * Detector de Intenciones Ligero (Intent Detection)
   * Responde frases predefinidas sin consultar al LLM
   */
  private detectFastIntent(text: string, session?: CallSession): string | null {
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
    const userTurnCount =
      session?.history.filter((m) => m.role === 'user').length ?? 0;
    const hasAssistantInHistory =
      session?.history.some((m) => m.role === 'assistant') ?? false;

    const isFirstTurn = userTurnCount === 0 || (userTurnCount === 1 && !hasAssistantInHistory);

    // Ignorar ruidos o monosílabos comunes en el primer turno para evitar respuestas sin sentido del LLM
    if (isFirstTurn) {
      const isNoise = /^(ah|eh|uh|mm|hm|hmm|mhmm|mhm|ajá|aja|ok|okay|vale)[.,?!]*$/i.test(cleanText);
      if (isNoise) {
        // Retornamos un intent silencioso que no hace nada
        console.log(`🔇 [${session?.callSid}] Ignorando ruido inicial/filler: "${text}"`);
        return 'IGNORE_NOISE'; // Señal especial para ignorar
      }
    }

    const holaExact =
      cleanText === 'hola' ||
      cleanText === 'buenas' ||
      cleanText === 'buenos dias' ||
      cleanText === 'buenas tardes' ||
      cleanText === 'buenas noches' ||
      cleanText === 'hola buenas' ||
      cleanText === 'hola hola' ||
      cleanText === 'alo' ||
      cleanText === 'bueno' ||
      cleanText === 'diga' ||
      cleanText === 'digame' ||
      cleanText === 'si' ||
      cleanText === 'si diga' ||
      cleanText === 'si digame';

    // STT suele devolver "hola que tal", "hola buenos dias", etc. — capturar saludos cortos
    const words = cleanText.split(/\s+/).filter(Boolean);
    // No tratar como saludo genérico si ya es una pregunta concreta (p. ej. "hola qué servicios tienen")
    const looksLikeRealQuestion =
      /\b(qu[eé]|cu[aá]l|cu[aá]les|c[oó]mo|d[oó]nde|cu[aá]ndo|cu[aá]nto|tienen|ofrecen|servicio|servicios|precio|producto|pedido|horario|cita|disponibilidad|turno)\b/i.test(
        cleanText,
      );
    const holaLoose =
      /^(hola|alo|bueno|diga|digame|si)\b/.test(cleanText) &&
      words.length <= 5 &&
      cleanText.length <= 56 &&
      !looksLikeRealQuestion;

    if (holaExact || holaLoose) {
      // Ya hubo saludo por voz (y opcionalmente ya está en history): no forzar al LLM a re-presentarse
      if (
        session &&
        session.greetingSent &&
        (userTurnCount <= 1 || hasAssistantInHistory)
      ) {
        return 'Sí, dime, ¿en qué puedo ayudarte?';
      }
      return '¡Hola! ¿En qué puedo ayudarte?';
    }

    return null;
  }

  /**
   * 🔥 Corrección dinámica para nombres de empresas
   * Se adapta automáticamente a la empresa del usuario
   */
  private async basicCompanyCorrection(
    text: string,
    session: CallSession,
  ): Promise<string> {
    let correctedText = text;

    // 1. Extraer el nombre de la empresa del usuario
    const companyName = await this.getUserCompanyName(session);

    if (!companyName) {
      // Si no hay nombre de empresa, aplicar correcciones genéricas
      return this.applyGenericCorrections(correctedText);
    }

    // 2. Generar variaciones fonéticas del nombre de la empresa
    const companyCorrections = this.generateCompanyCorrections(companyName);

    // 3. Aplicar correcciones específicas de la empresa
    companyCorrections.forEach((correction) => {
      if (correction.from.test(correctedText)) {
        correctedText = correctedText.replace(correction.from, correction.to);
      }
    });

    return correctedText;
  }

  /**
   * Extrae el nombre de la empresa del usuario desde Firestore o customParameters
   */
  private async getUserCompanyName(
    session: CallSession,
  ): Promise<string | null> {
    // 0. Reutilizar documento de usuario ya cargado en createSession (evita 2ª lectura a Firestore)
    if (session.userDocument) {
      const enterprise = session.userDocument.enterprise as
        | { name?: string }
        | undefined;
      if (
        enterprise?.name &&
        typeof enterprise.name === 'string' &&
        enterprise.name.trim().length > 2
      ) {
        return enterprise.name.trim();
      }
      const companyName = session.userDocument.companyName;
      if (
        companyName &&
        typeof companyName === 'string' &&
        companyName.trim().length > 2
      ) {
        return companyName.trim();
      }
    }

    // 1. Intentar desde customParameters (más rápido)
    const sources = [
      session.customParameters?.enterpriseName,
      session.customParameters?.companyName,
      session.customParameters?.businessName,
      session.customParameters?.agentName, // A veces el agente tiene el nombre de la empresa
    ];

    for (const source of sources) {
      if (source && typeof source === 'string' && source.trim().length > 2) {
        const name = source.trim();

        // Si es agentName, verificar si parece un nombre de empresa
        if (source === session.customParameters?.agentName) {
          if (
            name.toLowerCase().includes('ai') ||
            name.toLowerCase().includes('saas') ||
            name.toLowerCase().includes('tech') ||
            name.toLowerCase().includes('llamalo')
          ) {
            return name;
          }
        } else {
          return name;
        }
      }
    }

    // 2. Si no hay nada en customParameters, buscar en Firestore users.enterprise.name
    try {
      if (session.userId) {
        const userDoc = await admin
          .firestore()
          .collection('users')
          .doc(session.userId)
          .get();
        const userData = userDoc.data();

        if (userData?.enterprise?.name) {
          return userData.enterprise.name as string;
        }
      }
    } catch (firestoreError) {
      console.warn(
        `⚠️ [${session.callSid}] Error buscando empresa en Firestore:`,
        firestoreError instanceof Error
          ? firestoreError.message
          : String(firestoreError),
      );
    }

    if (session.customParameters?.shopDomain?.includes('llamalo')) {
      return 'Llamalo AI';
    }

    return null;
  }

  /**
   * Genera variaciones fonéticas para un nombre de empresa específico
   */
  private generateCompanyCorrections(
    companyName: string,
  ): Array<{ from: RegExp; to: string }> {
    const corrections: Array<{ from: RegExp; to: string }> = [];
    const name = companyName.toLowerCase();

    // 1. Variaciones con "AI" → "i", "ahi", "ay"
    if (name.includes('ai')) {
      const baseName = name.replace('ai', '').trim();

      // Generar variaciones del baseName (con/sin tildes, fonéticas)
      const baseNameVariations = this.generateBaseNameVariations(baseName);

      baseNameVariations.forEach((baseVariation) => {
        corrections.push(
          {
            from: new RegExp(`${this.escapeRegExp(baseVariation)} i`, 'gi'),
            to: companyName,
          },
          {
            from: new RegExp(`${this.escapeRegExp(baseVariation)} ahi`, 'gi'),
            to: companyName,
          },
          {
            from: new RegExp(`${this.escapeRegExp(baseVariation)} ay`, 'gi'),
            to: companyName,
          },
          {
            from: new RegExp(`${this.escapeRegExp(baseVariation)} ahí`, 'gi'),
            to: companyName,
          }, // CON TILDE
          {
            from: new RegExp(
              `${this.escapeRegExp(baseVariation)}[\\s-]+i`,
              'gi',
            ),
            to: companyName,
          }, // CON ESPACIO/GUION
          {
            from: new RegExp(
              `${this.escapeRegExp(baseVariation)}[\\s-]+ahi`,
              'gi',
            ),
            to: companyName,
          }, // CON ESPACIO/GUION
          {
            from: new RegExp(
              `${this.escapeRegExp(baseVariation)}[\\s-]+ahí`,
              'gi',
            ),
            to: companyName,
          }, // CON ESPACIO/GUION Y TILDE
        );
      });
    }

    // 2. Variaciones con espacios → unidos o con "de"
    if (name.includes(' ')) {
      const parts = name.split(' ');
      const joined = parts.join('');
      const withDe = parts.join(' de ');

      corrections.push(
        { from: new RegExp(this.escapeRegExp(joined), 'gi'), to: companyName },
        { from: new RegExp(this.escapeRegExp(withDe), 'gi'), to: companyName },
      );
    }

    // 3. Variaciones fonéticas comunes
    const phoneticVariations = this.generatePhoneticVariations(companyName);
    phoneticVariations.forEach((variation) => {
      corrections.push({
        from: new RegExp(this.escapeRegExp(variation.toLowerCase()), 'gi'),
        to: companyName,
      });
    });

    return corrections;
  }

  /**
   * Genera variaciones fonéticas para cualquier nombre de empresa
   */
  private generatePhoneticVariations(name: string): string[] {
    const variations: string[] = [];
    const lowerName = name.toLowerCase();

    // Variaciones de letras comunes
    const letterVariations: Record<string, string[]> = {
      ll: ['l', 'y'],
      v: ['b'],
      c: ['k', 's', 'z'],
      g: ['j'],
      z: ['s', 'c'],
    };

    // Aplicar variaciones letra por letra
    for (const [original, replacements] of Object.entries(letterVariations)) {
      if (lowerName.includes(original)) {
        replacements.forEach((replacement) => {
          variations.push(
            lowerName.replace(new RegExp(original, 'g'), replacement),
          );
        });
      }
    }

    return [...new Set(variations)];
  }

  /**
   * Genera variaciones del baseName para cualquier empresa (con/sin tildes, fonéticas)
   */
  private generateBaseNameVariations(baseName: string): string[] {
    const variations: string[] = [];
    const lowerBaseName = baseName.toLowerCase();

    // 1. Variación original
    variations.push(lowerBaseName);

    // 2. Variaciones fonéticas básicas
    const phoneticVariations = this.generatePhoneticVariations(baseName);
    variations.push(...phoneticVariations);

    // 3. Variaciones con tildes (comunes en español)
    const accentVariations = this.generateAccentVariations(lowerBaseName);
    variations.push(...accentVariations);

    // 4. Eliminar duplicados
    return [...new Set(variations)];
  }

  /**
   * Genera variaciones con tildes para texto en español
   */
  private generateAccentVariations(text: string): string[] {
    const variations: string[] = [];

    // Mapa de caracteres sin tilde → con tilde
    const accentMap: Record<string, string[]> = {
      a: ['á'],
      e: ['é'],
      i: ['í'],
      o: ['ó'],
      u: ['ú'],
    };

    // Para cada vocal, generar variación con tilde
    for (const [noAccent, withAccents] of Object.entries(accentMap)) {
      if (text.includes(noAccent)) {
        withAccents.forEach((accent) => {
          // Reemplazar todas las ocurrencias
          const withAccent = text.replace(new RegExp(noAccent, 'g'), accent);
          variations.push(withAccent);

          // También variación mixta (solo algunas con tilde)
          const mixed = text.replace(noAccent, accent);
          variations.push(mixed);
        });
      }
    }

    return [...new Set(variations)];
  }

  /**
   * Aplica correcciones genéricas cuando no hay empresa específica
   */
  private applyGenericCorrections(text: string): string {
    let correctedText = text;

    // Correcciones genéricas comunes
    const genericCorrections = [
      { from: /piseverde/gi, to: 'Pisaverde' },
      { from: /pisa verde/gi, to: 'Pisaverde' },
      { from: /pisaver de/gi, to: 'Pisaverde' },
    ];

    genericCorrections.forEach((correction) => {
      if (correction.from.test(correctedText)) {
        correctedText = correctedText.replace(correction.from, correction.to);
        console.log(
          `🔧 Corrección genérica: "${correction.from.source}" → "${correction.to}"`,
        );
      }
    });

    return correctedText;
  }

  /**
   * Escapa caracteres especiales para expresiones regulares
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
