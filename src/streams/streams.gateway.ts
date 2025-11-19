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
    process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
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

    ws.on('message', (data) =>
      this.handleOpenAiMessage(session, this.rawDataToString(data)),
    );
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
    this.sendToOpenAi(session, { type: 'response.create' });
  }

  private handleOpenAiMessage(session: CallSession, raw: string) {
    try {
      const message = JSON.parse(raw);

      if (message.type === 'response.output_audio.delta' && message.delta) {
        this.sendAudioToTwilio(session, message.delta as string);
        return;
      }

      if (message.type === 'input_audio_buffer.speech_stopped') {
        this.sendToOpenAi(session, { type: 'response.create' });
        return;
      }

      if (message.type === 'error') {
        console.error(`❌ [${session.callSid}] Error desde OpenAI:`, message);
        return;
      }

      if (message.type === 'response.completed') {
        console.log(`✅ [${session.callSid}] Respuesta OpenAI completada.`);
        return;
      }

      if (message.type === 'rate_limits.updated') {
        console.log(
          `📉 [${session.callSid}] Rate limits actualizados`,
          message,
        );
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
}
