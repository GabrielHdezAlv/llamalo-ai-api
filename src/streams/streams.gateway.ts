import { WebSocketGateway } from '@nestjs/websockets';
import WebSocket, { RawData } from 'ws';
import axios from 'axios';
import OpenAI from 'openai';
import { Readable } from 'stream';

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

interface CallSession {
  callSid: string;
  streamSid?: string;
  client: WebSocketClient;
  voiceAgentSocket?: WebSocket;
  sttSocket?: WebSocket;
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
  // Conversación para el LLM
  history: Message[];
  // Estado para interceptar texto y generar TTS
  interceptedResponseText: string;
  agentSpeaking: boolean;
  interrupted: boolean;
  currentTTSRequest?: Promise<void>;
  ttsCancelStream?: () => void;
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
  private readonly sttProvider = process.env.STT_PROVIDER ?? 'elevenlabs';
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
    process.env.ELEVENLABS_TTS_VOICE_ID ?? 'zRUArUmK0DWSP7K6mmLW';
  private readonly elevenLabsTtsModelId =
    process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_multilingual_v2';
  private readonly elevenLabsTtsStability = Number(
    process.env.ELEVENLABS_TTS_STABILITY ?? 0.5,
  );
  private readonly elevenLabsTtsStyle = Number(
    process.env.ELEVENLABS_TTS_STYLE ?? 0,
  );
  private readonly elevenLabsTtsSimilarity = Number(
    process.env.ELEVENLABS_TTS_SIMILARITY ?? 0.75,
  );
  private readonly elevenLabsTtsSpeakerBoost =
    (process.env.ELEVENLABS_TTS_SPEAKER_BOOST ?? 'true') === 'true';
  private readonly elevenLabsTtsVoiceSpeed = Number(
    process.env.ELEVENLABS_TTS_VOICE_SPEED ?? 1.0,
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

  constructor() {
    if (!this.elevenLabsApiKey) {
      console.warn('⚠️ ELEVENLABS_API_KEY no configurado en el entorno.');
    }
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️ OPENAI_API_KEY no configurado en el entorno.');
    }
  }

  private usingElevenLabs(): boolean {
    return this.sttProvider.toLowerCase() === 'elevenlabs';
  }

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (this.usingElevenLabs() && !this.elevenLabsApiKey) {
      console.error('❌ ELEVENLABS_API_KEY no configurado. Cerrando conexión.');
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
      history: [],
      interceptedResponseText: '',
      agentSpeaking: false,
      interrupted: false,
    };

    this.sessions.set(callSid, session);
    if (this.usingElevenLabs()) {
      void this.connectToElevenLabs(session);
    } else {
      void this.connectToDeepgram(session);
    }
  }

  private connectToElevenLabs(session: CallSession) {
    if (!this.elevenLabsApiKey) {
      console.error('❌ ELEVENLABS_API_KEY ausente. No se puede iniciar STT.');
      return;
    }

    const url = `${this.elevenLabsSttUrl}?model=${encodeURIComponent(this.elevenLabsSttModel)}&language=${encodeURIComponent(this.elevenLabsLanguage)}`;

    const ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.elevenLabsApiKey,
        'User-Agent': 'llamalo-ai/streams-gateway',
      },
    });

    session.voiceAgentSocket = ws;
    session.sttSocket = ws;

    ws.on('open', () => {
      console.log(`🔌 [${session.callSid}] STT ElevenLabs conectado`);
      try {
        ws.send(
          JSON.stringify({
            event: 'start',
            model: this.elevenLabsSttModel,
            language: this.elevenLabsLanguage,
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
        console.log(
          `🔌 [${session.callSid}] Conexión ElevenLabs STT cerrada (${code})`,
        );
      }
      session.readyForAudio = false;
    });

    ws.on('error', (error) => {
      console.error(
        `❌ [${session.callSid}] Error en ElevenLabs STT WS:`,
        error,
      );
    });
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
        `📝 [${session.callSid}] Transcripción final: "${text.substring(0, 120)}${text.length > 120 ? '...' : ''}"`,
      );
      void this.handleFinalTranscript(session, text.trim());
    } else {
      console.log(
        `✏️ [${session.callSid}] Parcial STT: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`,
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
      `🧾 [${session.callSid}] Texto usuario final (${text.length} chars): "${text.substring(0, 120)}${text.length > 120 ? '...' : ''}"`,
    );
    try {
      const completion = await this.openai.chat.completions.create({
        model: this.llmModel,
        temperature: this.llmTemperature,
        max_tokens: this.llmMaxTokens,
        messages: [
          { role: 'system', content: session.instructions },
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
        `💬 [${session.callSid}] Respuesta LLM: "${content.substring(0, 120)}${content.length > 120 ? '...' : ''}"`,
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

    if (!session.userSpeakingStartTime) {
      session.userSpeakingStartTime = Date.now();
    }
    if (session.agentSpeaking && !session.interrupted) {
      session.interrupted = true;
      if (session.ttsCancelStream) {
        session.ttsCancelStream();
      }
    }
    if (this.usingElevenLabs()) {
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
      if (this.usingElevenLabs()) {
        this.sendAudioChunkToElevenLabs(session, chunk);
      } else {
        this.sendAudioChunkToDeepgram(session, chunk);
      }
    });
  }

  private relayAudioToTwilio(session: CallSession, chunk: Buffer) {
    // Si hay una interrupción activa, no reenviar audio
    if (session.interrupted) {
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
                // IMPORTANTE: Resetear interrupted cuando el agente empieza a hablar
                session.interrupted = false;
              } else {
                // Si ya está hablando, resetear interrupted si estaba interrumpido
                // (puede pasar si el usuario interrumpió pero el agente continúa)
                if (session.interrupted) {
                  console.log(
                    `🔄 [${session.callSid}] Reseteando interrupted=false porque el agente continúa hablando`,
                  );
                  session.interrupted = false;
                }
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
    if (session.interrupted || !text.trim()) {
      console.log(
        `⏸️ [${session.callSid}] TTS cancelado (interrupted: ${session.interrupted}, text vacío: ${!text.trim()})`,
      );
      return;
    }

    // Evitar solapes de TTS
    if (session.currentTTSRequest) {
      try {
        console.log(
          `⏳ [${session.callSid}] Esperando TTS anterior antes de procesar nuevo texto`,
        );
        await session.currentTTSRequest;
      } catch {
        // Ignorar errores previos
      }
    }

    console.log(
      `🎵 [${session.callSid}] Iniciando TTS para texto: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
    );

    console.log(`🔄 [${session.callSid}] Llamando a streamElevenLabsTTS...`);
    session.currentTTSRequest = this.streamElevenLabsTTS(session, text)
      .then(() => {
        console.log(
          `✅ [${session.callSid}] TTS completado para: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
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
        console.log(`🏁 [${session.callSid}] Finalizando TTS request`);
        session.currentTTSRequest = undefined;
      });
    console.log(
      `⏳ [${session.callSid}] Esperando a que termine el TTS request...`,
    );
    await session.currentTTSRequest;
    console.log(`✅ [${session.callSid}] TTS request terminado`);
  }

  private async streamElevenLabsTTS(
    session: CallSession,
    text: string,
  ): Promise<void> {
    console.log(
      `🚀 [${session.callSid}] streamElevenLabsTTS llamado con texto: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
    );

    if (!this.elevenLabsApiKey) {
      console.error(
        `❌ [${session.callSid}] ELEVENLABS_API_KEY no configurado para TTS.`,
      );
      return;
    }

    if (!this.elevenLabsTtsVoiceId) {
      console.error(
        `❌ [${session.callSid}] ELEVENLABS_TTS_VOICE_ID no configurado. Por favor, configura una variable de entorno ELEVENLABS_TTS_VOICE_ID con un ID de voz válido de ElevenLabs (ej: pNInz6obpgDQGcFmaJgB).`,
      );
      return;
    }

    const voiceId = this.elevenLabsTtsVoiceId;
    const url = `${this.elevenLabsBaseUrl}/text-to-speech/${voiceId}/stream`;

    console.log(
      `🔗 [${session.callSid}] URL ElevenLabs: ${url}, voiceId: ${voiceId}`,
    );

    try {
      session.agentSpeaking = true;
      console.log(
        `🔊 [${session.callSid}] Iniciando TTS ElevenLabs (${text.length} chars, voice=${voiceId})`,
      );
      console.log(
        `📤 [${session.callSid}] Enviando petición POST a ElevenLabs...`,
      );

      // Logging adicional para debugging
      console.log(
        `🔑 [${session.callSid}] API Key presente: ${this.elevenLabsApiKey ? 'Sí' : 'No'}`,
      );
      console.log(
        `📋 [${session.callSid}] Payload: ${JSON.stringify({
          text: text.trim().substring(0, 50) + (text.length > 50 ? '...' : ''),
          model_id: this.elevenLabsTtsModelId,
          output_format: 'ulaw_8000',
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
          },
          output_format: 'pcm_16000',
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
        `✅ [${session.callSid}] Respuesta recibida de ElevenLabs, status: ${response.status}`,
      );
      console.log(
        `📡 [${session.callSid}] Headers de respuesta:`,
        JSON.stringify(response.headers).substring(0, 300),
      );

      const audioStream = response.data as Readable;

      if (!audioStream) {
        console.error(
          `❌ [${session.callSid}] audioStream es null o undefined`,
        );
        throw new Error('audioStream es null o undefined');
      }

      console.log(
        `📡 [${session.callSid}] Stream ElevenLabs creado correctamente`,
      );

      const cancel = () => {
        session.agentSpeaking = false;
        audioStream.destroy();
      };
      session.ttsCancelStream = cancel;

      await new Promise<void>((resolve, reject) => {
        // Timeout de seguridad (30 segundos)
        const timeout = setTimeout(() => {
          console.error(
            `⏱️ [${session.callSid}] Timeout esperando stream ElevenLabs TTS`,
          );
          cancel();
          reject(new Error('Timeout esperando stream ElevenLabs TTS'));
        }, 30000);
        let chunksReceived = 0;
        let totalBytes = 0;

        audioStream.on('data', (chunk: Buffer) => {
          if (session.interrupted) {
            console.log(
              `🛑 [${session.callSid}] TTS interrumpido, cancelando stream`,
            );
            clearTimeout(timeout);
            cancel();
            return;
          }
          chunksReceived++;
          totalBytes += chunk.length;
          if (chunksReceived === 1 || chunksReceived % 10 === 0) {
            console.log(
              `📦 [${session.callSid}] Chunk ${chunksReceived} recibido (${chunk.length} bytes, total: ${totalBytes} bytes)`,
            );
          }
          this.relayAudioToTwilio(session, Buffer.from(chunk));
        });
        audioStream.on('end', () => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          console.log(
            `✅ [${session.callSid}] Stream ElevenLabs TTS terminado (${chunksReceived} chunks, ${totalBytes} bytes totales)`,
          );
          resolve();
        });
        audioStream.on('close', () => {
          clearTimeout(timeout);
          session.ttsCancelStream = undefined;
          console.log(
            `✅ [${session.callSid}] Stream ElevenLabs TTS cerrado (${chunksReceived} chunks, ${totalBytes} bytes totales)`,
          );
          resolve();
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

        // Log cuando el stream está listo
        audioStream.on('readable', () => {
          console.log(`📖 [${session.callSid}] Stream ElevenLabs readable`);
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
          `✅ [${session.callSid}] TTS ElevenLabs completado en ${Date.now() - (session.userSpeakingStartTime || Date.now())}ms`,
        );
      }
    }
  }

  private maybeSendPendingGreeting(session: CallSession) {
    if (!session.pendingGreeting || session.greetingSent) {
      return;
    }

    console.log(
      `👋 [${session.callSid}] Enviando greeting a Deepgram: "${session.pendingGreeting.substring(0, 50)}${session.pendingGreeting.length > 50 ? '...' : ''}"`,
    );

    // Enviar greeting a Deepgram usando InjectAgentMessage
    // Esto hará que Deepgram lo procese y genere la respuesta, que luego interceptaremos
    this.sendJsonToDeepgram(session, {
      type: 'InjectAgentMessage',
      message: session.pendingGreeting,
    });
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
