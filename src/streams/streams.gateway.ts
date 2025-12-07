import { WebSocketGateway } from '@nestjs/websockets';
import WebSocket, { RawData } from 'ws';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

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

interface CallSession {
  callSid: string;
  streamSid?: string;
  client: WebSocketClient;
  voiceAgentSocket?: WebSocket;
  customParameters?: Record<string, string>;
  instructions: string;
  queuedAudio: Buffer[];
  readyForAudio: boolean;
  pendingGreeting?: string;
  greetingSent: boolean;
  keepAliveTimer?: NodeJS.Timeout;
  deepgramRequestId?: string;
  userSpeakingStartTime?: number;
  responseLatencies: number[];
  // Google Cloud TTS
  ttsClient?: TextToSpeechClient;
  // Estado para interceptar texto y generar TTS
  interceptedResponseText: string;
  agentSpeaking: boolean;
  interrupted: boolean;
  currentTTSRequest?: Promise<void>;
}

@WebSocketGateway({
  path: '/voice/stream',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class StreamsGateway {
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
  // Google Cloud TTS
  private readonly googleCloudProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  private readonly googleCloudCredentials =
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  private readonly ttsVoiceName =
    process.env.GOOGLE_TTS_VOICE_NAME || 'es-ES-Neural2-D';
  private ttsClient: TextToSpeechClient;

  private sessions: Map<string, CallSession> = new Map();

  constructor() {
    // Inicializar cliente de Google Cloud TTS
    const config: { projectId?: string; keyFilename?: string } = {};
    if (this.googleCloudProjectId) {
      config.projectId = this.googleCloudProjectId;
    }
    if (this.googleCloudCredentials) {
      config.keyFilename = this.googleCloudCredentials;
    }

    this.ttsClient = new TextToSpeechClient(
      Object.keys(config).length > 0 ? config : undefined,
    );

    // Log de confirmación de inicialización
    if (this.googleCloudCredentials) {
      console.log(
        `✅ Google Cloud Text-to-Speech inicializado (Project: ${this.googleCloudProjectId || 'default'}, Voice: ${this.ttsVoiceName})`,
      );
    } else {
      console.warn(
        '⚠️ GOOGLE_APPLICATION_CREDENTIALS no configurado. Google Cloud TTS usará Application Default Credentials.',
      );
    }
  }

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (!this.deepgramApiKey) {
      console.error(
        '❌ DG_API_KEY o DG_VOICE_AGENT_API_KEY no configurado. Cerrando conexión.',
      );
      client.close();
      return;
    }

    let currentCallSid = '';
    let mediaBeforeStartWarned = false;

    client.on('message', (raw: Buffer) => {
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

          this.createSession(currentCallSid, client, msg.start);
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
          console.log(`🛑 [${currentCallSid || 'unknown'}] Llamada terminada.`);
          this.cleanupSession(currentCallSid);
          client.close();
        }
      } catch (err) {
        console.error('❌ Error procesando mensaje Twilio:', err);
      }
    });
  }

  private createSession(
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
    if (customParameters?.greetingUrl) {
      console.warn(
        `ℹ️ [${callSid}] Se recibió greetingUrl (${customParameters.greetingUrl}) pero Deepgram Voice Agent no soporta reproducir URLs externas.`,
      );
    }

    if (customParameters?.instructions) {
      console.log(
        `📋 [${callSid}] AgentInstruction recibido desde Twilio: "${customParameters.instructions.substring(0, 100)}..."`,
      );
    } else {
      console.log(
        `⚠️ [${callSid}] No se recibió agentInstruction desde Twilio (customParameters.instructions está vacío)`,
      );
    }

    const instructions = this.resolveInstructions(customParameters);

    console.log(
      `🧠 [${callSid}] Session.instructions configurado: "${instructions.substring(0, 100)}..."`,
    );

    const session: CallSession = {
      callSid,
      streamSid: start?.streamSid,
      client,
      customParameters,
      instructions,
      queuedAudio: [],
      readyForAudio: false,
      pendingGreeting: this.resolveGreeting(customParameters),
      greetingSent: false,
      responseLatencies: [],
      interceptedResponseText: '',
      agentSpeaking: false,
      interrupted: false,
    };

    this.sessions.set(callSid, session);
    void this.connectToDeepgram(session);
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

    ws.on('close', (code) => {
      if (code !== 1000 && code !== 1001) {
        console.log(
          `🔌 [${session.callSid}] Conexión Deepgram cerrada (${code})`,
        );
      }
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

    if (msg.media.track && msg.media.track !== 'inbound') {
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

    this.sendAudioChunkToDeepgram(session, chunk);
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

  private flushQueuedAudio(session: CallSession) {
    if (!session.queuedAudio.length) return;
    const buffered = [...session.queuedAudio];
    session.queuedAudio.length = 0;
    buffered.forEach((chunk) => this.sendAudioChunkToDeepgram(session, chunk));
  }

  private relayAudioToTwilio(session: CallSession, chunk: Buffer) {
    // Si hay una interrupción activa, no reenviar audio
    if (session.interrupted) {
      return;
    }

    if (!session.streamSid) {
      console.warn(
        `⚠️ [${session.callSid}] No hay streamSid para enviar audio a Twilio`,
      );
      return;
    }

    try {
      session.client.send(
        JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: chunk.toString('base64') },
        }),
      );
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a Twilio:`,
        error,
      );
    }
  }

  private handleDeepgramMessage(
    session: CallSession,
    data: RawData,
    isBinary: boolean,
  ) {
    if (isBinary) {
      // Ignorar audio TTS binario de Deepgram - usaremos Google Cloud TTS en su lugar
      // No reenviar este audio a Twilio
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
          if (session.deepgramRequestId) {
            console.log(
              `🆔 [${session.callSid}] Deepgram Request ID: ${session.deepgramRequestId}`,
            );
          }
          break;
        case 'SettingsApplied':
          session.readyForAudio = true;
          console.log(`⚙️ [${session.callSid}] Deepgram listo`);
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
              `🗣️ [${session.callSid}] Agente hablando (latencia: ${latency}ms, promedio: ${Math.round(avgLatency)}ms)`,
            );
            session.userSpeakingStartTime = undefined;
          } else {
            console.log(`🗣️ [${session.callSid}] Agente hablando`);
          }
          break;
        case 'AgentAudioDone':
          // El texto ya fue procesado en tiempo real con ConversationText
          // Solo limpiar el estado
          session.agentSpeaking = false;
          session.interrupted = false;
          session.interceptedResponseText = '';
          console.log(`✅ [${session.callSid}] Agente terminó de hablar`);
          break;
        case 'UserStartedSpeaking':
          session.userSpeakingStartTime = Date.now();
          // Si el agente está hablando, interrumpir
          if (session.agentSpeaking) {
            console.log(
              `🛑 [${session.callSid}] Usuario interrumpió al agente`,
            );
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
            `🔍 [${session.callSid}] ConversationText recibido (agentSpeaking: ${session.agentSpeaking}):`,
            JSON.stringify(message).substring(0, 500),
          );

          // Interceptar el texto de la conversación
          const text = this.extractTextFromConversationText(message);
          const role = this.extractRoleFromConversationText(message);

          console.log(
            `🔍 [${session.callSid}] Texto extraído: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}", Rol: ${role || 'null'}`,
          );

          if (text) {
            // Procesar incluso si agentSpeaking es false (podría ser el greeting)
            if (role === 'assistant' || role === 'agent' || !role) {
              if (!session.agentSpeaking) {
                // Si no está hablando pero hay texto del agente, podría ser el greeting
                console.log(
                  `📝 [${session.callSid}] Texto del agente recibido antes de AgentStartedSpeaking (probablemente greeting)`,
                );
                session.agentSpeaking = true; // Marcar como hablando para procesar
              }

              // Acumular texto de respuesta del agente
              session.interceptedResponseText += text;
              // Generar TTS en tiempo real para cada fragmento
              console.log(
                `📝 [${session.callSid}] Texto interceptado del agente: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
              );
              void this.streamTTSFromText(session, text);
            } else if (role === 'user') {
              // Ignorar texto del usuario en ConversationText
              console.log(
                `👤 [${session.callSid}] Texto del usuario en ConversationText (ignorado)`,
              );
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
              `📝 [${session.callSid}] Texto interceptado de ${type}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
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
            `⚠️ [${session.callSid}] FunctionCallRequest no soportado`,
          );
          break;
        case 'History':
          // Silenciar este evento
          break;
        default:
          // Loggear TODOS los eventos para debugging
          console.log(
            `🔍 [${session.callSid}] Evento Deepgram recibido: ${type}`,
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
    if (session.interrupted || !text.trim()) return;

    // Evitar procesar si ya hay una solicitud TTS en curso para el mismo texto
    if (session.currentTTSRequest) {
      // Esperar a que termine la solicitud anterior antes de procesar nueva
      try {
        await session.currentTTSRequest;
      } catch {
        // Ignorar errores de la solicitud anterior
      }
    }

    try {
      if (!session.ttsClient) {
        session.ttsClient = this.ttsClient;
      }

      // Determinar género basándose en el nombre de la voz
      // Para Neural2: -D y -F son femeninas; para Standard: -A, -C son femeninas; -B, -D son masculinas
      const voiceName = this.ttsVoiceName.toLowerCase();
      let ssmlGender: 'MALE' | 'FEMALE' = 'FEMALE'; // Por defecto femenino

      if (voiceName.includes('neural2')) {
        // Neural2: -D y -F son femeninas
        ssmlGender = 'FEMALE';
      } else if (voiceName.includes('standard')) {
        // Standard: -A, -C son femeninas; -B, -D son masculinas
        if (voiceName.endsWith('-b') || voiceName.endsWith('-d')) {
          ssmlGender = 'MALE';
        } else {
          ssmlGender = 'FEMALE';
        }
      } else {
        // Para otras voces, usar FEMALE como predeterminado
        ssmlGender = 'FEMALE';
      }

      const request = {
        input: { text: text.trim() },
        voice: {
          languageCode: 'es-ES',
          name: this.ttsVoiceName,
          ssmlGender: ssmlGender,
        },
        audioConfig: {
          audioEncoding: 'MULAW' as const,
          sampleRateHertz: 8000,
        },
      };

      const ttsPromise = session.ttsClient.synthesizeSpeech(request);
      session.currentTTSRequest = ttsPromise.then(() => {
        session.currentTTSRequest = undefined;
      });

      const [response] = await ttsPromise;
      if (response.audioContent && !session.interrupted) {
        const audioBuffer = Buffer.from(response.audioContent);
        this.relayAudioToTwilio(session, audioBuffer);
      }
    } catch (error) {
      session.currentTTSRequest = undefined;
      if (!session.interrupted) {
        console.error(
          `❌ [${session.callSid}] Error en Text-to-Speech:`,
          error,
        );
      }
    }
  }

  private maybeSendPendingGreeting(session: CallSession) {
    if (!session.pendingGreeting || session.greetingSent) {
      return;
    }

    // Enviar greeting usando Google Cloud TTS
    void this.streamTTSFromText(session, session.pendingGreeting);
    session.greetingSent = true;
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

    console.log(`🧹 [${callSid}] Limpiando sesión`);

    this.stopKeepAlive(session);

    if (
      session.voiceAgentSocket &&
      session.voiceAgentSocket.readyState === WebSocket.OPEN
    ) {
      session.voiceAgentSocket.close();
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
