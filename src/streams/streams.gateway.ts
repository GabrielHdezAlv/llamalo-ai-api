import { WebSocketGateway } from '@nestjs/websockets';
import WebSocket, { RawData } from 'ws';

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

interface CallSession {
  callSid: string;
  streamSid?: string;
  client: WebSocketClient;
  openAiSocket?: WebSocket;
  customParameters?: Record<string, string>;
  responseInProgress: boolean;
  queuedAssistantTurn: boolean;
  currentResponseId?: string;
}

@WebSocketGateway({
  path: '/voice/stream',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class StreamsGateway {
  private readonly openAiApiKey =
    process.env.OPENAI_API_KEY || process.env.OPENAI_REALTIME_API_KEY;
  private readonly openAiUrl =
    process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime';
  private readonly openAiModel =
    process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  private readonly openAiVoice = process.env.OPENAI_REALTIME_VOICE || 'alloy';
  private readonly openAiTemperature = Number(
    process.env.OPENAI_REALTIME_TEMPERATURE || '0.8',
  );
  private readonly defaultInstructions =
    process.env.OPENAI_REALTIME_SYSTEM_PROMPT ||
    'Eres un asistente de voz profesional y resolutivo. Responde siempre en español con frases cortas y claras.';

  private sessions: Map<string, CallSession> = new Map();

  handleConnection(client: WebSocketClient) {
    console.log('🛰️ Twilio WS conectado');

    if (!this.openAiApiKey) {
      console.error(
        '❌ OPENAI_API_KEY/OPENAI_REALTIME_API_KEY no configurado. Cerrando conexión.',
      );
      client.close();
      return;
    }

    let currentCallSid = '';
    let mediaBeforeStartWarned = false;

    client.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as TwilioMsg;

        if (msg.event !== 'media') {
          console.log('📨 Twilio mensaje NO-MEDIA recibido:', msg.event);
          console.log('📋 Contenido completo:', JSON.stringify(msg, null, 2));
        }

        if (msg.event === 'connected') {
          console.log(
            '🔗 Twilio WebSocket conectado:',
            JSON.stringify(msg, null, 2),
          );
          return;
        }

        if (msg.event === 'start') {
          console.log(
            '📋 Mensaje completo del start:',
            JSON.stringify(msg, null, 2),
          );
          currentCallSid = msg.start?.callSid || '';
          console.log(`🎯 CallSid recibido: "${currentCallSid}"`);
          console.log('🎯 StreamSid:', msg.start?.streamSid || 'N/A');
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

    const session: CallSession = {
      callSid,
      streamSid: start?.streamSid,
      client,
      customParameters,
      responseInProgress: false,
      queuedAssistantTurn: false,
    };

    this.sessions.set(callSid, session);
    console.log(
      `📝 [${callSid}] Sesión creada. Conectando con OpenAI Realtime...`,
    );
    void this.connectToOpenAi(session);
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

  private connectToOpenAi(session: CallSession) {
    const url = `${this.openAiUrl}?model=${encodeURIComponent(
      this.openAiModel,
    )}&voice=${encodeURIComponent(this.openAiVoice)}&temperature=${encodeURIComponent(
      String(this.openAiTemperature),
    )}`;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.openAiApiKey}`,
      },
    });

    session.openAiSocket = ws;

    ws.on('open', () => {
      console.log(`🧠 [${session.callSid}] OpenAI Realtime conectado`);
      this.sendSessionUpdate(session);
      this.triggerInitialGreeting(session);
    });

    ws.on('message', (data) => {
      const raw = this.rawDataToString(data);
      if (process.env.OPENAI_REALTIME_DEBUG === 'true') {
        console.log(`🔁 [${session.callSid}] OpenAI raw: ${raw}`);
      }

      this.handleOpenAiMessage(session, raw);
    });
    ws.on('close', () => {
      console.log(`🔌 [${session.callSid}] Conexión OpenAI cerrada`);
    });
    ws.on('error', (error) => {
      console.error(`❌ [${session.callSid}] Error en OpenAI WS:`, error);
    });
  }

  private sendSessionUpdate(session: CallSession) {
    const instructions =
      session.customParameters?.instructions || this.defaultInstructions;

    const payload = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.openAiModel,
        instructions,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: 'server_vad' },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: this.openAiVoice,
          },
        },
      },
    };

    this.sendToOpenAi(session, payload);
  }

  private triggerInitialGreeting(session: CallSession) {
    const agentName =
      session.customParameters?.agentName?.trim() || 'tu asistente virtual';

    const greeting =
      session.customParameters?.greeting?.trim() ||
      `Hola, soy ${agentName}. ¿En qué puedo ayudarte hoy?`;

    const message = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: greeting,
          },
        ],
      },
    };

    this.sendToOpenAi(session, message);
    this.requestAssistantTurn(session, 'initial-greeting');
  }

  private handleOpenAiMessage(session: CallSession, raw: string) {
    try {
      const message = JSON.parse(raw);
      const type = message.type as string | undefined;

      switch (type) {
        case 'response.output_audio.delta':
          if (message.delta) {
            this.sendAudioToTwilio(session, message.delta as string);
          }
          return;
        case 'response.created':
        case 'response.updated':
          if (message.response?.id) {
            session.currentResponseId = message.response.id as string;
          }
          return;
        case 'response.completed':
          console.log(`✅ [${session.callSid}] Respuesta OpenAI completada.`);
          session.responseInProgress = false;
          session.currentResponseId = undefined;
          this.flushQueuedAssistantTurn(session, 'completed');
          return;
        case 'response.canceled':
          console.log(`🚫 [${session.callSid}] Respuesta OpenAI cancelada.`);
          session.responseInProgress = false;
          session.currentResponseId = undefined;
          this.flushQueuedAssistantTurn(session, 'canceled');
          return;
        case 'input_audio_buffer.speech_started':
          if (session.responseInProgress) {
            this.cancelAssistantResponse(session, 'speech-started');
          }
          return;
        case 'input_audio_buffer.speech_stopped':
          this.requestAssistantTurn(session, 'speech-stopped');
          return;
        case 'error': {
          console.error(`❌ [${session.callSid}] Error desde OpenAI:`, message);
          const code = message?.error?.code as string | undefined;
          if (code !== 'conversation_already_has_active_response') {
            session.responseInProgress = false;
            session.currentResponseId = undefined;
            this.flushQueuedAssistantTurn(session, code || 'error');
          } else {
            console.warn(
              `⚠️ [${session.callSid}] Turno rechazado por respuesta activa.`,
            );
          }
          return;
        }
        case 'rate_limits.updated':
          console.log(
            `📉 [${session.callSid}] Rate limits actualizados`,
            message,
          );
          return;
        default:
          return;
      }
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error interpretando mensaje OpenAI:`,
        error,
      );
    }
  }

  private sendAudioToTwilio(session: CallSession, payload: string) {
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
          media: { payload },
        }),
      );
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando audio a Twilio:`,
        error,
      );
    }
  }

  private forwardInboundAudio(callSid: string, msg: TwilioMediaIn) {
    const session = this.sessions.get(callSid);
    if (!session) {
      console.warn(
        `⚠️ [${callSid}] No hay sesión registrada para media inbound`,
      );
      return;
    }

    if (!msg.media || !msg.media.payload) {
      console.warn(`⚠️ [${callSid}] Media sin payload`);
      return;
    }

    if (msg.media.track && msg.media.track !== 'inbound') {
      return;
    }

    const payload = {
      type: 'input_audio_buffer.append',
      audio: msg.media.payload,
    };

    this.sendToOpenAi(session, payload);
  }

  private sendToOpenAi(session: CallSession, payload: unknown) {
    if (
      !session.openAiSocket ||
      session.openAiSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    try {
      session.openAiSocket.send(JSON.stringify(payload));
    } catch (error) {
      console.error(
        `❌ [${session.callSid}] Error enviando mensaje a OpenAI:`,
        error,
      );
    }
  }

  private cleanupSession(callSid: string) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    console.log(`🧹 [${callSid}] Limpiando sesión`);

    if (
      session.openAiSocket &&
      session.openAiSocket.readyState === WebSocket.OPEN
    ) {
      session.openAiSocket.close();
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

  private buildAudioResponsePayload() {
    return {
      type: 'response.create',
    };
  }

  private requestAssistantTurn(session: CallSession, reason: string) {
    if (session.responseInProgress) {
      session.queuedAssistantTurn = true;
      console.log(
        `⏳ [${session.callSid}] Turno asistente en cola (motivo: ${reason})`,
      );
      return;
    }

    console.log(`🎤 [${session.callSid}] Generando respuesta (${reason})`);
    session.responseInProgress = true;
    session.queuedAssistantTurn = false;
    this.sendToOpenAi(session, this.buildAudioResponsePayload());
  }

  private flushQueuedAssistantTurn(session: CallSession, source: string) {
    if (!session.queuedAssistantTurn) {
      return;
    }

    console.log(
      `🔁 [${session.callSid}] Procesando turno en cola (evento: ${source})`,
    );
    session.queuedAssistantTurn = false;
    this.requestAssistantTurn(session, 'queued');
  }

  private cancelAssistantResponse(session: CallSession, reason: string) {
    if (!session.currentResponseId) {
      return;
    }

    console.log(
      `✋ [${session.callSid}] Cancelando respuesta actual (${reason})`,
    );
    this.sendToOpenAi(session, {
      type: 'response.cancel',
      response_id: session.currentResponseId,
    });
  }
}
