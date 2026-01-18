import { WebSocketGateway } from '@nestjs/websockets';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';
import { spawn } from 'child_process';
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

type Role = 'user' | 'assistant';
type Message = { role: Role; content: string };

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
  outboundSendTimer?: NodeJS.Timeout;
  readyForAudio: boolean;
  pendingGreeting?: string;
  greetingSent: boolean;
  keepAliveTimer?: NodeJS.Timeout;
  deepgramRequestId?: string;
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
  currentTTSRequest?: Promise<void>;
  ttsCancelStream?: () => void;
  // Shopify integration
  userId?: string;
  shopifyContext?: ShopifyContext;
}

@WebSocketGateway({
  path: '/voice/stream',
  cors: {
    origin: '*',
    credentials: true,
  },
})
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

  private readonly elevenLabsTtsOutputFormat = 'ulaw_8000' as const; // Para Twilio usamos μ-law 8k directo (evita conversión adicional)
  private readonly elevenLabsTtsModelId =
    process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_flash_v2_5';
  private readonly elevenLabsTtsStability = Number(
    process.env.ELEVENLABS_TTS_STABILITY ?? 0.72,
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
  private readonly llmModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  private readonly llmTemperature = Number(
    process.env.OPENAI_TEMPERATURE ?? 0.4,
  );
  private readonly llmMaxTokens = Number(process.env.OPENAI_MAX_TOKENS ?? 200);

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

  constructor(private readonly shopifyService: ShopifyService) {
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

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (this.usingElevenLabs() && !this.elevenLabsApiKey) {
      console.error(
        '❌ ELEVENLABS_API_KEY no configurado. Se intentará fallback a Deepgram.',
      );
    }

    let currentCallSid = '';
    let mediaBeforeStartWarned = false;

    client.on('message', (raw: Buffer) => {
      void (async () => {
        try {
          const msg = JSON.parse(raw.toString()) as TwilioMsg;

          if (msg.event === 'connected') {
            return;
          }

          if (msg.event === 'start') {
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
            this.cleanupSession(currentCallSid);
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

    // 🔍 Debug: Log de todos los customParameters recibidos
    if (customParameters && Object.keys(customParameters).length > 0) {
      console.log(
        `🔍 [${callSid}] CustomParameters recibidos:`,
        Object.keys(customParameters).join(', '),
      );
      if (customParameters.userId) {
        console.log(
          `👤 [${callSid}] userId en customParameters: ${customParameters.userId}`,
        );
      }
      if (customParameters.shopDomain) {
        console.log(
          `🛍️ [${callSid}] shopDomain en customParameters: ${customParameters.shopDomain}`,
        );
      } else {
        console.warn(`⚠️ [${callSid}] shopDomain NO está en customParameters`);
      }
    } else {
      console.warn(`⚠️ [${callSid}] No se recibieron customParameters`);
    }

    if (customParameters?.instructions) {
      console.log(
        `📋 AgentInstruction recibido desde Twilio: "${customParameters.instructions.substring(0, 100)}..."`,
      );
      console.log(
        `ℹ️ AgentInstruction longitud=${customParameters.instructions.length} tail="${customParameters.instructions.slice(-60)}"`,
      );
    } else {
      console.log(
        `⚠️ [${callSid}] No se recibió agentInstruction desde Twilio (customParameters.instructions está vacío)`,
      );
    }

    // Extraer userId y shopDomain de customParameters para integración Shopify
    const userId = customParameters?.userId?.trim();
    const shopDomain = customParameters?.shopDomain?.trim();

    if (userId) {
      console.log(`👤 [${callSid}] userId extraído: ${userId}`);
    }
    if (shopDomain) {
      console.log(`🛍️ [${callSid}] shopDomain extraído: ${shopDomain}`);
    }

    const instructions = this.resolveInstructions(customParameters);
    const voiceId = this.resolveVoiceId(customParameters);
    if (!voiceId) {
      console.warn(
        `⚠️ [${callSid}] No se recibió labsId/voiceId; se usará fallback de entorno: ${this.elevenLabsTtsVoiceId}`,
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
      shopifyContext: shopDomain ? { shopDomain } : undefined,
    };

    this.sessions.set(callSid, session);
    if (session.pendingGreeting) {
      this.maybeSendPendingGreeting(session);
    }
    if (this.usingElevenLabs(session)) {
      void this.connectToElevenLabs(session);
    } else {
      void this.connectToDeepgram(session);
    }

    // Cargar contexto inicial de Shopify (espera para garantizar disponibilidad)
    if (userId && shopDomain && session.shopifyContext) {
      await this.loadInitialShopifyContext(session);
    }
  }

  /**
   * Carga el contexto inicial de Shopify (tienda y productos destacados)
   * Se ejecuta de forma síncrona durante la inicialización para garantizar
   * que el contexto esté disponible cuando el usuario haga su primera pregunta
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
      const loadPromise = Promise.all([
        this.shopifyService.getStoreInfo(userId, shopDomain),
        this.shopifyService.getProducts(userId, shopDomain),
        this.shopifyService.getOrders(userId, shopDomain),
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
      } else {
        // DEBUG: Log de pedidos recibidos de Shopify
        console.log(
          `🔍 [DEBUG-${session.callSid}] Pedidos recibidos de Shopify API (${ordersResponse.orders.length}):`,
          ordersResponse.orders.map((o) => ({
            orderName: o.orderName,
            totalPrice: o.totalPrice,
            currency: o.currency,
            createdAt: o.createdAt,
          })),
        );
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

        // DEBUG: Log de pedidos después de ordenar y filtrar
        console.log(
          `🔍 [DEBUG-${session.callSid}] Pedidos después de ordenar y filtrar (${recentOrders.length}):`,
          recentOrders.map((o) => ({
            orderName: o.orderName,
            totalPrice: o.totalPrice,
            createdAt: o.createdAt,
          })),
        );
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

          // DEBUG: Log de pedidos guardados en session.shopifyContext
          console.log(
            `🔍 [DEBUG-${session.callSid}] Pedidos guardados en session.shopifyContext.orders:`,
            session.shopifyContext.orders?.map((o) => ({
              orderName: o.orderName,
              totalPrice: o.totalPrice,
              createdAt: o.createdAt,
            })),
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

    // DEBUG: Ver estado del contexto ANTES de cualquier operación
    console.log(
      `🔍 [DEBUG-${session.callSid}] queryShopifyDataIfNeeded llamado:`,
      {
        userText: userText.substring(0, 50),
        hasContext: !!session.shopifyContext,
        hasStore: !!session.shopifyContext?.store,
        productsCount: session.shopifyContext?.featuredProducts?.length || 0,
        ordersCount: session.shopifyContext?.orders?.length || 0,
      },
    );

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
        console.log(
          `🔍 [DEBUG-${session.callSid}] No se detectó necesidad de consultar Shopify, usando cache existente`,
        );
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
  private enrichInstructionsWithShopify(session: CallSession): string {
    const baseInstructions = session.instructions;

    try {
      const shopifyContext = session.shopifyContext;

      // DEBUG CRÍTICO: Ver qué hay en el contexto cuando se llama esta función
      console.log(
        `🔍 [DEBUG-${session.callSid}] enrichInstructionsWithShopify llamado:`,
        {
          hasContext: !!shopifyContext,
          hasStore: !!shopifyContext?.store,
          productsCount: shopifyContext?.featuredProducts?.length || 0,
          ordersCount: shopifyContext?.orders?.length || 0,
          orders: shopifyContext?.orders?.map((o) => o.orderName) || [],
        },
      );

      // Si no hay contexto de Shopify o no tiene datos, retornar instrucciones originales
      if (
        !shopifyContext ||
        (!shopifyContext.store &&
          !shopifyContext.featuredProducts?.length &&
          !shopifyContext.orders?.length)
      ) {
        console.warn(
          `⚠️ [DEBUG-${session.callSid}] Saliendo sin enriquecer - no hay datos suficientes en contexto`,
        );
        return baseInstructions;
      }

      // Construir contexto de Shopify como JSON estructurado
      const shopifyData: {
        tienda?: NormalizedStore;
        productosDestacados?: NormalizedProduct[];
        pedidosRecientes?: NormalizedOrder[];
      } = {};

      try {
        if (shopifyContext.store) {
          shopifyData.tienda = shopifyContext.store;
        }

        if (
          shopifyContext.featuredProducts &&
          shopifyContext.featuredProducts.length > 0
        ) {
          shopifyData.productosDestacados = shopifyContext.featuredProducts;
        }

        if (shopifyContext.orders && shopifyContext.orders.length > 0) {
          shopifyData.pedidosRecientes = shopifyContext.orders;

          // DEBUG: Log de pedidos que se incluirán en el JSON para el LLM
          console.log(
            `🔍 [DEBUG-${session.callSid}] Pedidos que se incluirán en JSON para LLM (${shopifyContext.orders.length}):`,
            shopifyContext.orders.map((o) => ({
              orderName: o.orderName,
              totalPrice: o.totalPrice,
              currency: o.currency,
              customer: o.customer
                ? `${o.customer.firstName} ${o.customer.lastName}`
                : 'N/A',
            })),
          );
        } else {
          // DEBUG: Log si NO hay pedidos
          console.warn(
            `⚠️ [DEBUG-${session.callSid}] NO hay pedidos para incluir en JSON (orders: ${shopifyContext.orders?.length || 0})`,
          );
        }
      } catch (dataError) {
        console.warn(
          `⚠️ [${session.callSid}] Error construyendo datos de Shopify para enriquecimiento:`,
          dataError instanceof Error ? dataError.message : String(dataError),
        );
        // Continuar sin datos si hay error construyendo el objeto
        return baseInstructions;
      }

      // Formatear como JSON para que el LLM lo entienda fácilmente
      let shopifyContextJson: string;
      try {
        shopifyContextJson = JSON.stringify(shopifyData, null, 2);

        // DEBUG: Log del JSON completo que se enviará (solo primeros 500 caracteres para no saturar)
        console.log(
          `🔍 [DEBUG-${session.callSid}] JSON serializado para LLM (primeros 800 chars):`,
          shopifyContextJson.substring(0, 800) + '...',
        );
      } catch (jsonError) {
        // JSON.stringify puede fallar con objetos circulares o datos inválidos
        console.error(
          `❌ [${session.callSid}] Error serializando datos Shopify a JSON:`,
          jsonError instanceof Error ? jsonError.message : String(jsonError),
        );
        // Retornar instrucciones base si no se puede serializar
        return baseInstructions;
      }

      // Enriquecer las instrucciones agregando el contexto de Shopify
      try {
        const enrichedInstructions = `${baseInstructions}

============================================================
## ⭐ CONTEXTO DE LA TIENDA SHOPIFY ⭐
============================================================

🚨 **IMPORTANTE**: Este es el JSON que DEBES consultar cuando el usuario pregunte sobre pedidos, productos o información de la tienda.

**Datos disponibles:**
- \`tienda\`: Información general de la tienda
- \`productosDestacados\`: Los 10 productos más importantes
- \`pedidosRecientes\`: Los últimos 10 pedidos (⭐ REVISA ESTE CAMPO PARA PREGUNTAS DE PEDIDOS)

**JSON con datos reales:**

\`\`\`json
${shopifyContextJson}
\`\`\`

**Instrucciones de uso:**
1. Para preguntas sobre PEDIDOS → Busca el campo "pedidosRecientes" en este JSON
2. Para preguntas sobre PRODUCTOS → Busca el campo "productosDestacados" en este JSON
3. Para preguntas sobre la TIENDA → Busca el campo "tienda" en este JSON
4. NUNCA digas "no tengo acceso" si el dato está en este JSON
5. SIEMPRE usa los datos reales de este JSON, NO inventes información

============================================================`;

        return enrichedInstructions;
      } catch (stringError) {
        console.error(
          `❌ [${session.callSid}] Error construyendo instrucciones enriquecidas:`,
          stringError instanceof Error
            ? stringError.message
            : String(stringError),
        );
        // Retornar instrucciones base si hay error construyendo el string
        return baseInstructions;
      }
    } catch (error) {
      // Manejar cualquier error inesperado sin bloquear el flujo
      console.error(
        `❌ [${session.callSid}] Error en enrichInstructionsWithShopify:`,
        error instanceof Error ? error.message : String(error),
      );
      // Retornar instrucciones base como fallback
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
    } catch {
      // ignore
    }
    try {
      session.voiceAgentSocket?.close();
    } catch {
      // ignore
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
    } catch {
      console.warn(`⚠️ [${session.callSid}] Mensaje STT no parseable`, raw);
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
      console.log(
        `📝 Transcripción final: "${text.substring(0, 120)}${text.length > 120 ? '...' : ''}"`,
      );
      void this.handleFinalTranscript(session, text.trim());
    } else {
      console.log(
        `✏️ Parcial STT: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`,
      );
      // Si el usuario habla durante TTS, interrumpir
      if (session.agentSpeaking && !session.interrupted) {
        session.interrupted = true;
        if (session.ttsCancelStream) {
          session.ttsCancelStream();
        }
      }
    }
  }

  private async handleFinalTranscript(session: CallSession, text: string) {
    session.userSpeakingStartTime = undefined;
    session.history.push({ role: 'user', content: text });
    console.log(
      `🧾 Texto usuario final (${text.length} chars): "${text.substring(0, 120)}${text.length > 120 ? '...' : ''}"`,
    );
    try {
      // Consultar datos de Shopify bajo demanda si el usuario necesita información fresca
      // Si falla o hay timeout, se usa el cache existente en session.shopifyContext
      try {
        await this.queryShopifyDataIfNeeded(session, text);
      } catch (error) {
        // Manejar errores silenciosamente (usar cache existente)
        console.warn(
          `⚠️ [${session.callSid}] Error consultando datos Shopify bajo demanda (usando cache):`,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Enriquecer las instrucciones con datos de Shopify si están disponibles
      let enrichedInstructions: string;
      try {
        enrichedInstructions = this.enrichInstructionsWithShopify(session);
      } catch (error) {
        // Si falla el enriquecimiento, usar instrucciones base
        console.warn(
          `⚠️ [${session.callSid}] Error enriqueciendo instrucciones con Shopify (usando instrucciones base):`,
          error instanceof Error ? error.message : String(error),
        );
        enrichedInstructions = session.instructions;
      }

      const completion = await this.openai.chat.completions.create({
        model: this.llmModel,
        temperature: this.llmTemperature,
        max_tokens: this.llmMaxTokens,
        messages: [
          { role: 'system', content: enrichedInstructions },
          ...session.history,
        ],
      });

      const content = completion.choices[0]?.message?.content?.trim() || '';
      if (!content) {
        console.warn(
          `⚠️ [${session.callSid}] Respuesta LLM vacía para texto: "${text}"`,
        );
        return;
      }

      session.history.push({ role: 'assistant', content });
      session.agentSpeaking = true;
      session.interrupted = false;
      console.log(
        `💬 Respuesta LLM: "${content.substring(0, 120)}${content.length > 120 ? '...' : ''}"`,
      );
      await this.streamTTSFromText(session, content);
      session.agentSpeaking = false;
      session.interceptedResponseText = '';
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
        },
      },
      // Mantener speak configurado pero ignoraremos el audio TTS que Deepgram envía
      speak: {
        provider: {
          type: this.deepgramSpeakProvider,
          model: this.deepgramSpeakModel,
        },
      },
    };

    const contextMessages =
      session.instructions?.trim().length > 0
        ? [
            {
              type: 'History',
              role: 'assistant',
              content: session.instructions,
            },
          ]
        : [];
    if (contextMessages.length) {
      agent.context = { messages: contextMessages };
    }

    const thinkConfig = this.buildThinkConfig();
    if (thinkConfig) {
      agent.think = {
        ...thinkConfig,
        prompt: session.instructions,
      };
    }

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
    const instructions =
      customParameters?.instructions?.trim() || this.defaultInstructions;
    return instructions;
  }

  private resolveVoiceId(
    customParameters?: Record<string, string>,
  ): string | undefined {
    const customVoice =
      customParameters?.labsId ||
      customParameters?.voiceId ||
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

  private forwardInboundAudio(callSid: string, msg: TwilioMediaIn) {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(
        `⚠️ [${callSid}] No hay sesión registrada para media inbound`,
      );
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

    if (!session.userSpeakingStartTime) {
      session.userSpeakingStartTime = Date.now();
    }
    if (session.agentSpeaking && !session.interrupted) {
      session.interrupted = true;
      if (session.ttsCancelStream) {
        session.ttsCancelStream();
      }
    }
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
      let audioChunk = chunk;
      const normalizedFormat = this.normalizeTtsFormat(
        ttsFormat ?? this.elevenLabsTtsOutputFormat,
      );

      // Guardarraíl: si detectamos MP3 en relay, decodificar y reconvertir
      if (this.isMp3Header(audioChunk)) {
        console.warn(
          `⚠️ [${session.callSid}] Chunk con cabecera MP3 en relay; decodificando a PCM16k`,
        );
        const pcm16k = await this.decodeMp3ToPcm16k(audioChunk);
        audioChunk = pcm16k;
      }

      const { payload, stripped } = this.stripWavHeaderIfPresent(audioChunk);
      if (stripped) {
        console.log(
          `ℹ️ [${session.callSid}] Cabecera WAV detectada en TTS; se envía payload μ-law crudo`,
        );
        audioChunk = payload;
      }

      if (normalizedFormat === 'pcm_16000') {
        audioChunk = this.convertPcm16kToUlaw8k(audioChunk);
      } else if (normalizedFormat !== 'ulaw_8000') {
        // Formato inesperado; enviar tal cual pero loguear advertencia
        console.warn(
          `⚠️ [${session.callSid}] Formato TTS no μ-law/PCM16k (${String(normalizedFormat)}); se envía sin convertir`,
        );
      }

      this.enqueueOutboundFrames(session, audioChunk);
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
    session.outboundBuffer = Buffer.concat([
      session.outboundBuffer ?? Buffer.alloc(0),
      audioChunk,
    ]);

    const sendFrame = () => {
      if (!session.outboundBuffer || session.outboundBuffer.length < 160) {
        session.outboundSendTimer = undefined;
        return;
      }
      const frame = session.outboundBuffer.subarray(0, 160);
      session.outboundBuffer = session.outboundBuffer.subarray(160);
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
      } catch (err) {
        console.error(
          `❌ [${session.callSid}] Error enviando frame a Twilio:`,
          err,
        );
      }
      session.outboundSendTimer = setTimeout(sendFrame, 20);
    };

    if (!session.outboundSendTimer) {
      session.outboundSendTimer = setTimeout(sendFrame, 0);
    }
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
          session.agentSpeaking = true;
          session.interrupted = false;
          session.interceptedResponseText = '';
          if (session.userSpeakingStartTime) {
            const latency = Date.now() - session.userSpeakingStartTime;
            session.responseLatencies.push(latency);
            const avgLatency =
              session.responseLatencies.reduce((a, b) => a + b, 0) /
              session.responseLatencies.length;
            console.log(
              `🗣️ Agente hablando (latencia: ${latency}ms, promedio: ${Math.round(avgLatency)}ms)`,
            );
            session.userSpeakingStartTime = undefined;
          } else {
            console.log(`🗣️ Agente hablando`);
          }
          break;
        case 'AgentAudioDone':
          // El texto ya fue procesado en tiempo real con ConversationText
          // Solo limpiar el estado
          session.agentSpeaking = false;
          session.interrupted = false;
          session.interceptedResponseText = '';
          console.log(`✅ Agente terminó de hablar`);
          break;
        case 'UserStartedSpeaking':
          session.userSpeakingStartTime = Date.now();
          // Si el agente está hablando, interrumpir
          if (session.agentSpeaking && session.allowInterruptions !== false) {
            console.log(`🛑 Usuario interrumpió al agente`);
            session.interrupted = true;
            session.agentSpeaking = false;
          }
          break;
        case 'AgentThinking':
          // Silenciar este evento para reducir ruido
          break;
        case 'ConversationText': {
          // Loggear TODOS los eventos ConversationText para debugging
          console.log(
            `🔍 ConversationText recibido (agentSpeaking: ${session.agentSpeaking}):`,
            JSON.stringify(message).substring(0, 500),
          );

          // Interceptar el texto de la conversación
          const text = this.extractTextFromConversationText(message);
          const role = this.extractRoleFromConversationText(message);

          console.log(
            `🔍 Texto extraído: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}", Rol: ${role || 'null'}`,
          );

          if (text) {
            // Procesar incluso si agentSpeaking es false (podría ser el greeting)
            if (role === 'assistant' || role === 'agent' || !role) {
              // Detectar marcador de finalización [END_CALL]
              const shouldHangup = text.includes('[END_CALL]');
              // Limpiar el marcador del texto antes de procesarlo
              const cleanText = text.replace(/\[END_CALL\]/gi, '').trim();

              if (shouldHangup) {
                console.log(
                  `👋 [${session.callSid}] Marcador [END_CALL] detectado en despedida`,
                );
              }

              if (!session.agentSpeaking) {
                // Si no está hablando pero hay texto del agente, podría ser el greeting
                session.agentSpeaking = true; // Marcar como hablando para procesar
                // IMPORTANTE: Resetear interrupted cuando el agente empieza a hablar
                session.interrupted = false;
                // Durante el greeting, deshabilitar barge-in
                session.allowInterruptions = false;
              } else {
                // Si ya está hablando, resetear interrupted si estaba interrumpido
                // (puede pasar si el usuario interrumpió pero el agente continúa)
                if (session.interrupted) {
                  console.log(
                    `🔄 Reseteando interrupted=false porque el agente continúa hablando`,
                  );
                  session.interrupted = false;
                }
              }

              // Acumular texto de respuesta del agente (con texto limpio)
              session.interceptedResponseText += cleanText;
              // Generar TTS en tiempo real para cada fragmento (con texto limpio)
              void this.streamTTSFromText(session, cleanText);

              // Si debe colgar, programar el colgado después de que termine el TTS
              if (shouldHangup) {
                // Esperar 3 segundos para que el TTS termine y haya un pequeño silencio
                setTimeout(() => {
                  console.log(
                    `📞 [${session.callSid}] Ejecutando colgado programado por despedida`,
                  );
                  void this.hangupCall(session);
                }, 3000);
              }
            } else if (role === 'user') {
              // Procesar texto del usuario como transcript final
              console.log(
                `👤 Texto del usuario en ConversationText - procesando como transcript final`,
              );
              // El usuario ha terminado de hablar, procesar su mensaje
              void this.handleFinalTranscript(session, text);
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
            session.interceptedResponseText += text;
            console.log(
              `📝 Texto interceptado de ${type}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
            );
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
          // Loggear TODOS los eventos para debugging
          console.log(
            `🔍 Evento Deepgram recibido: ${type}`,
            JSON.stringify(message).substring(0, 500),
          );
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

  private async streamTTSFromText(session: CallSession, text: string) {
    if (session.interrupted || !text.trim()) {
      console.log(
        `⏸️ TTS cancelado (interrupted: ${session.interrupted}, text vacío: ${!text.trim()})`,
      );
      return;
    }

    // Evitar solapes de TTS
    if (session.currentTTSRequest) {
      try {
        console.log(`⏳ Esperando TTS anterior antes de procesar nuevo texto`);
        await session.currentTTSRequest;
      } catch {
        // Ignorar errores previos
      }
    }

    // Si es el primer TTS (greeting), deshabilitar interrupciones
    const wasGreetingPending = session.greetingPlaybackDone !== true;
    if (wasGreetingPending) {
      session.allowInterruptions = false;
    }
    // Asegurar que no haya marca de interrupción previa antes de iniciar TTS
    session.interrupted = false;

    session.currentTTSRequest = this.streamElevenLabsTTS(session, text)
      .then(() => {
        console.log(
          `✅ TTS completado para: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
        );
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
        console.log(`🏁 Finalizando TTS request`);
        session.currentTTSRequest = undefined;
        if (wasGreetingPending) {
          session.allowInterruptions = true;
          session.greetingPlaybackDone = true;
        }
      });
    await session.currentTTSRequest;
  }

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
        `❌ [${session.callSid}] No se pudo resolver labsId/voiceId (customParameters ni entorno).`,
      );
      return;
    }

    // Log del voiceId que se está usando para TTS
    console.log(`🎙️ [${session.callSid}] Usando Voice ID para TTS: ${voiceId}`);

    const normalizedFormat = this.normalizeTtsFormat(
      this.elevenLabsTtsOutputFormat,
    );
    const url = `${this.elevenLabsBaseUrl}/text-to-speech/${voiceId}/stream?output_format=${encodeURIComponent(normalizedFormat)}`;

    try {
      session.agentSpeaking = true;

      // Logging adicional para debugging
      console.log(
        `📋 Payload streamElevenLabsTTS: ${JSON.stringify({
          text: text.trim().substring(0, 50) + (text.length > 50 ? '...' : ''),
          model_id: this.elevenLabsTtsModelId,
          output_format: normalizedFormat,
        })}`,
      );

      const response = await axios.post(
        url,
        {
          text: text.trim(),
          model_id: this.elevenLabsTtsModelId,
          voice_settings: {
            stability: this.elevenLabsTtsStability,
            similarity_boost: this.elevenLabsTtsSimilarity,
            style: this.elevenLabsTtsStyle,
            use_speaker_boost: this.elevenLabsTtsSpeakerBoost,
            voice_speed: this.elevenLabsTtsVoiceSpeed,
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
        } catch {
          errorMessage = errorBody || errorMessage;
        }
        throw new Error(`ElevenLabs TTS error: ${errorMessage}`);
      }

      console.log(
        `✅ Respuesta recibida de ElevenLabs, status: ${response.status}`,
      );
      console.log(
        `📡 Headers de respuesta:`,
        JSON.stringify(response.headers).substring(0, 300),
      );
      const contentType = (response.headers['content-type'] as string) || '';
      console.log(
        `📡 Content-Type recibido de ElevenLabs: ${contentType || 'desconocido'}`,
      );

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
        const forceMp3Buffering = contentType
          .toLowerCase()
          .includes('audio/mpeg');

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
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });
        audioStream.on('end', () => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          if (mp3Chunks && mp3Chunks.length) {
            void this.decodeMp3AndRelay(session, Buffer.concat(mp3Chunks))
              .then(resolve)
              .catch((err) => {
                console.error(
                  `❌ [${session.callSid}] Error decodificando MP3 de ElevenLabs:`,
                  err,
                );
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          } else {
            resolve();
          }
        });
        audioStream.on('close', () => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          if (mp3Chunks && mp3Chunks.length) {
            void this.decodeMp3AndRelay(session, Buffer.concat(mp3Chunks))
              .then(resolve)
              .catch((err) => {
                console.error(
                  `❌ [${session.callSid}] Error decodificando MP3 de ElevenLabs (close):`,
                  err,
                );
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          } else {
            resolve();
          }
        });
        audioStream.on('error', (err) => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          console.error(
            `❌ [${session.callSid}] Error en stream ElevenLabs TTS:`,
            err,
          );
          reject(err);
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
        console.log(
          `✅ TTS ElevenLabs completado en ${Date.now() - (session.userSpeakingStartTime || Date.now())}ms`,
        );
      }
    }
  }

  private maybeSendPendingGreeting(session: CallSession) {
    if (!session.pendingGreeting || session.greetingSent) {
      return;
    }

    const greeting = session.pendingGreeting;

    console.log(
      `👋 Reproduciendo greeting con ElevenLabs TTS: "${greeting.substring(0, 50)}${greeting.length > 50 ? '...' : ''}"`,
    );
    session.greetingSent = true;
    void this.streamTTSFromText(session, greeting).catch((error) => {
      session.greetingSent = false;
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

  private stopKeepAlive(session: CallSession) {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = undefined;
    }
  }

  private async hangupCall(session: CallSession) {
    try {
      console.log(`📞 [${session.callSid}] Iniciando colgado de llamada`);

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

    this.stopKeepAlive(session);

    if (session.outboundSendTimer) {
      clearTimeout(session.outboundSendTimer);
      session.outboundSendTimer = undefined;
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
}
