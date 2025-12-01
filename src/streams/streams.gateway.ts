import { WebSocketGateway } from '@nestjs/websockets';
import WebSocket, { RawData } from 'ws';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

interface GeminiMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface CallSession {
  callSid: string;
  streamSid?: string;
  client: WebSocketClient;
  customParameters?: Record<string, string>;
  instructions: string;
  queuedAudio: Buffer[];
  readyForAudio: boolean;
  pendingGreeting?: string;
  greetingSent: boolean;
  userSpeakingStartTime?: number;
  responseLatencies: number[];
  // Google Cloud clients
  sttClient?: SpeechClient;
  sttStream?: any; // StreamingRecognizeStream
  geminiClient?: GoogleGenerativeAI;
  geminiModel?: any; // GenerativeModel
  ttsClient?: TextToSpeechClient;
  conversationHistory: GeminiMessage[];
  agentSpeaking: boolean;
  interrupted: boolean;
  currentTTSRequest?: any;
}

@WebSocketGateway({
  path: '/voice/stream',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class StreamsGateway {
  private readonly geminiApiKey = process.env.GEMINI_API_KEY;
  private readonly googleCloudProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  private readonly googleCloudCredentials =
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  private readonly ttsVoiceName =
    process.env.GOOGLE_TTS_VOICE_NAME || 'es-ES-Neural2-D';
  private readonly geminiModelName =
    process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  private readonly geminiTemperature = Number(
    process.env.GEMINI_TEMPERATURE ?? 0.7,
  );
  private readonly defaultInstructions =
    process.env.GEMINI_AGENT_PROMPT ||
    'Eres un asistente de voz profesional y resolutivo. Responde siempre en español con frases cortas y claras.';
  private readonly maxBufferedChunks = Math.max(
    1,
    Number(process.env.MAX_BUFFERED_CHUNKS ?? 25),
  );

  private sessions: Map<string, CallSession> = new Map();
  private speechClient: SpeechClient;
  private ttsClient: TextToSpeechClient;

  constructor() {
    // Inicializar clientes de Google Cloud
    const config: { projectId?: string; keyFilename?: string } = {};
    if (this.googleCloudProjectId) {
      config.projectId = this.googleCloudProjectId;
    }
    if (this.googleCloudCredentials) {
      config.keyFilename = this.googleCloudCredentials;
    }

    this.speechClient = new SpeechClient(
      Object.keys(config).length > 0 ? config : undefined,
    );
    this.ttsClient = new TextToSpeechClient(
      Object.keys(config).length > 0 ? config : undefined,
    );
  }

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (!this.geminiApiKey) {
      console.error('❌ GEMINI_API_KEY no configurado. Cerrando conexión.');
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
        `ℹ️ [${callSid}] Se recibió greetingUrl (${customParameters.greetingUrl}) pero Google Cloud TTS requiere procesar el audio primero.`,
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
      conversationHistory: [],
      agentSpeaking: false,
      interrupted: false,
    };

    this.sessions.set(callSid, session);
    void this.initializeGoogleServices(session);
  }

  private initializeGoogleServices(session: CallSession) {
    try {
      // Inicializar Gemini
      this.connectToGemini(session);

      // Inicializar Speech-to-Text
      this.connectToGoogleSTT(session);

      // Marcar como listo para audio
      session.readyForAudio = true;
      console.log(
        `⚙️ [${session.callSid}] Servicios de Google Cloud inicializados`,
      );

      // Enviar audio en cola
      this.flushQueuedAudio(session);

      // Enviar greeting si existe
      void this.maybeSendPendingGreeting(session);
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error inicializando servicios de Google Cloud:`,
        error,
      );
    }
  }

  private connectToGemini(session: CallSession) {
    try {
      const genAI = new GoogleGenerativeAI(this.geminiApiKey!);
      const model = genAI.getGenerativeModel({
        model: this.geminiModelName,
        generationConfig: {
          temperature: this.geminiTemperature,
        },
      });

      session.geminiClient = genAI;
      session.geminiModel = model;

      // Inicializar conversación con instrucciones del agente
      const systemInstruction = {
        role: 'user' as const,
        parts: [{ text: session.instructions }],
      };
      session.conversationHistory = [systemInstruction];

      console.log(`✅ [${session.callSid}] Cliente Gemini inicializado`);
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error conectando a Gemini:`,
        error,
      );
      throw error;
    }
  }

  private connectToGoogleSTT(session: CallSession) {
    try {
      const request = {
        config: {
          encoding: 'MULAW' as const,
          sampleRateHertz: 8000,
          languageCode: 'es-ES',
          enableAutomaticPunctuation: true,
          model: 'latest_long',
          useEnhanced: true,
        },
        interimResults: true,
        singleUtterance: false,
      };

      const recognizeStream = this.speechClient
        .streamingRecognize(request)
        .on('error', (error) => {
          console.error(
            `❌ [${session.callSid}] Error en Speech-to-Text:`,
            error,
          );
        })
        .on('data', (data) => {
          void this.handleSTTResult(session, data);
        });

      session.sttClient = this.speechClient;
      session.sttStream = recognizeStream;

      console.log(`✅ [${session.callSid}] Speech-to-Text streaming iniciado`);
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error conectando a Speech-to-Text:`,
        error,
      );
      throw error;
    }
  }

  private async handleSTTResult(session: CallSession, data: any) {
    if (!data.results || data.results.length === 0) return;

    const result = data.results[0];
    const transcript = result.alternatives[0]?.transcript;

    if (!transcript) return;

    // Verificar si es resultado final (isFinalTranscript puede no existir, usar stability)
    const isFinal = result.isFinalTranscript || result.stability > 0.9;

    // Solo procesar resultados finales (no interim)
    if (isFinal) {
      console.log(`👤 [${session.callSid}] Usuario dijo: "${transcript}"`);

      // Si el agente está hablando, interrumpir inmediatamente
      if (session.agentSpeaking) {
        console.log(`🛑 [${session.callSid}] Usuario interrumpió al agente`);
        session.interrupted = true;
        session.agentSpeaking = false;
      }

      // Añadir mensaje del usuario al historial
      session.conversationHistory.push({
        role: 'user',
        parts: [{ text: transcript }],
      });

      // Procesar con Gemini (esto se ejecutará incluso si hubo interrupción)
      session.userSpeakingStartTime = Date.now();
      await this.processWithGemini(session);
    }
  }

  private async processWithGemini(session: CallSession) {
    try {
      if (!session.geminiModel) {
        console.error(`❌ [${session.callSid}] Modelo Gemini no inicializado`);
        return;
      }

      // Preparar historial de conversación para Gemini
      const chat = session.geminiModel.startChat({
        history: session.conversationHistory.slice(0, -1), // Todos excepto el último mensaje
        generationConfig: {
          temperature: this.geminiTemperature,
        },
      });

      // Obtener el último mensaje del usuario
      const lastUserMessage =
        session.conversationHistory[session.conversationHistory.length - 1];

      // Generar respuesta con streaming
      const result = await chat.sendMessageStream(
        lastUserMessage.parts[0].text,
      );
      let fullResponse = '';

      session.agentSpeaking = true;
      session.interrupted = false;

      // Procesar respuesta en streaming
      for await (const chunk of result.stream) {
        if (session.interrupted) {
          break;
        }

        const chunkText = chunk.text();
        if (chunkText && typeof chunkText === 'string') {
          fullResponse += chunkText;
          // Convertir a audio en tiempo real
          await this.streamTTSChunk(session, chunkText);
        }
      }

      if (!session.interrupted && fullResponse) {
        // Añadir respuesta del agente al historial
        session.conversationHistory.push({
          role: 'model',
          parts: [{ text: fullResponse }],
        });

        // Calcular latencia
        if (session.userSpeakingStartTime) {
          const latency = Date.now() - session.userSpeakingStartTime;
          session.responseLatencies.push(latency);
          const avgLatency =
            session.responseLatencies.reduce((a, b) => a + b, 0) /
            session.responseLatencies.length;
          console.log(
            `🗣️ [${session.callSid}] Agente respondió (latencia: ${latency}ms, promedio: ${Math.round(avgLatency)}ms)`,
          );
          session.userSpeakingStartTime = undefined;
        }

        console.log(`✅ [${session.callSid}] Agente terminó de hablar`);
      }

      session.agentSpeaking = false;
      session.interrupted = false;
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error procesando con Gemini:`,
        error,
      );
      session.agentSpeaking = false;
    }
  }

  private async streamTTSChunk(session: CallSession, text: string) {
    if (session.interrupted || !text.trim()) return;

    try {
      if (!session.ttsClient) {
        session.ttsClient = this.ttsClient;
      }

      const request = {
        input: { text },
        voice: {
          languageCode: 'es-ES',
          name: this.ttsVoiceName,
          ssmlGender: 'NEUTRAL' as const,
        },
        audioConfig: {
          audioEncoding: 'MULAW' as const,
          sampleRateHertz: 8000,
        },
      };

      const [response] = await session.ttsClient.synthesizeSpeech(request);
      if (response.audioContent) {
        const audioBuffer = Buffer.from(response.audioContent);
        this.relayAudioToTwilio(session, audioBuffer);
      }
    } catch (error) {
      if (!session.interrupted) {
        console.error(
          `❌ [${session.callSid}] Error en Text-to-Speech:`,
          error,
        );
      }
    }
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

    this.sendAudioChunkToSTT(session, chunk);
  }

  private sendAudioChunkToSTT(session: CallSession, chunk: Buffer) {
    if (!session.sttStream) {
      return;
    }

    try {
      session.sttStream.write({ audioContent: chunk });
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a Speech-to-Text:`,
        error,
      );
    }
  }

  private flushQueuedAudio(session: CallSession) {
    if (!session.queuedAudio.length) return;
    const buffered = [...session.queuedAudio];
    session.queuedAudio.length = 0;
    buffered.forEach((chunk) => this.sendAudioChunkToSTT(session, chunk));
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

  private async maybeSendPendingGreeting(session: CallSession) {
    if (!session.pendingGreeting || session.greetingSent) {
      return;
    }

    console.log(
      `👋 [${session.callSid}] Enviando greeting: "${session.pendingGreeting.substring(0, 50)}..."`,
    );

    // Enviar greeting como primer mensaje del agente
    await this.streamTTSChunk(session, session.pendingGreeting);
    session.greetingSent = true;
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

    // Cerrar stream de Speech-to-Text
    if (session.sttStream) {
      try {
        session.sttStream.end();
      } catch {
        // Ignorar errores al cerrar
      }
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
