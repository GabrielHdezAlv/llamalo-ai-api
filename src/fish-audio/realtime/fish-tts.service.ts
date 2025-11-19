import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  FishTtsInit,
  FishTtsText,
  FishTtsIncoming,
  FishTtsCancel,
} from './types';
import axios from 'axios';

type QueuedTtsItem = {
  utteranceId: string;
  text: string;
  sequenceId?: number;
  priority: number;
  metadata?: Record<string, unknown>;
  submittedAt: number;
  emotion?: string;
  style?: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  textType?: 'plain' | 'ssml';
  latency?: string;
  format?: string;
  extras?: Record<string, unknown>;
};

@Injectable()
export class FishTtsService implements OnModuleDestroy {
  private ws?: WebSocket;
  private listeners: Array<
    (
      pcm: Int16Array,
      info: {
        isFinal?: boolean;
        utteranceId?: string;
        sequenceId?: number;
        startMs?: number;
        endMs?: number;
      },
    ) => void
  > = [];
  private ready = false;
  private sessionId?: string;
  private keepAliveInterval?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private expectingEnd = false;
  private queue: QueuedTtsItem[] = [];
  private currentUtteranceId?: string;
  private currentPriority = Number.NEGATIVE_INFINITY;
  private readonly defaultLatency = process.env.FISH_TTS_LATENCY_MODE;
  private readonly defaultFormat = process.env.FISH_TTS_AUDIO_FORMAT;
  private readonly defaultEmotion = process.env.FISH_TTS_EMOTION;
  private readonly defaultStyle = process.env.FISH_TTS_STYLE;
  private readonly defaultTextType = process.env.FISH_TTS_TEXT_TYPE as
    | 'plain'
    | 'ssml'
    | undefined;
  private readonly defaultSpeed = toOptionalNumber(process.env.FISH_TTS_SPEED);
  private readonly defaultPitch = toOptionalNumber(process.env.FISH_TTS_PITCH);
  private readonly defaultVolume = toOptionalNumber(
    process.env.FISH_TTS_VOLUME,
  );
  private readonly defaultModel = process.env.FISH_TTS_MODEL;
  private readonly initExtras = parseJsonEnv(
    process.env.FISH_TTS_INIT_OPTIONS_JSON,
  );
  private readonly textExtras = parseJsonEnv(
    process.env.FISH_TTS_TEXT_OPTIONS_JSON,
  );

  connect(): Promise<void> {
    this.shouldReconnect = true;

    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.stopKeepAlive();
      this.clearReconnectTimer();

      const sessionId = randomUUID();
      this.ready = false;
      this.sessionId = sessionId;

      const url = 'wss://api.fish.audio/realtime/tts';
      try {
        this.ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}` },
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (!this.ws) {
        reject(new Error('Failed to create WebSocket'));
        return;
      }

      let settled = false;

      const handleOpen = () => {
        const init: FishTtsInit = {
          type: 'tts_init',
          voice_id: process.env.FISH_TTS_VOICE_ID!,
          language: process.env.FISH_LANG || 'es-ES',
          sample_rate: 8000,
          encoding: 'pcm16',
          session_id: sessionId,
        };
        if (this.defaultLatency) {
          init.latency = this.defaultLatency;
        }
        if (this.defaultFormat) {
          init.format = this.defaultFormat;
        }
        if (this.defaultModel) {
          init.model = this.defaultModel;
        }
        Object.assign(init, this.initExtras);
        try {
          this.ws!.send(JSON.stringify(init));
        } catch (error) {
          settled = true;
          this.cleanupListeners(
            handleOpen,
            handleMessage,
            handleError,
            handleClose,
          );
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const handleMessage = (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as FishTtsIncoming;
          switch (msg.type) {
            case 'tts_ready':
              if (!this.ready) {
                this.ready = true;
                this.sessionId = msg.session_id || sessionId;
                this.reconnectAttempts = 0;
                this.startKeepAlive();
                if (!settled) {
                  settled = true;
                  this.ws?.off('open', handleOpen);
                  resolve();
                }
              }
              this.processQueue();
              break;
            case 'tts_error': {
              const errorMessage =
                msg.error || 'Fish Audio TTS reported an unknown error';
              if (!this.ready && !settled) {
                settled = true;
                this.cleanupListeners(
                  handleOpen,
                  handleMessage,
                  handleError,
                  handleClose,
                );
                reject(new Error(errorMessage));
              } else {
                console.error('Fish Audio TTS error:', errorMessage);
                this.markCurrentComplete();
              }
              break;
            }
            case 'tts_end': {
              const endMsg = msg;
              console.log(
                `Fish Audio TTS indicó fin de audio${
                  endMsg.reason ? `: ${endMsg.reason}` : ''
                }`,
              );
              this.ready = false;
              this.stopKeepAlive();
              const wasExpected = this.expectingEnd;
              this.expectingEnd = false;
              this.markCurrentComplete();
              if (!settled) {
                settled = true;
                this.cleanupListeners(
                  handleOpen,
                  handleMessage,
                  handleError,
                  handleClose,
                );
                reject(
                  new Error(
                    endMsg.reason ||
                      'Fish Audio TTS ended unexpectedly before ready',
                  ),
                );
              } else if (this.shouldReconnect) {
                this.scheduleReconnect(wasExpected ? 1000 : undefined);
              }
              break;
            }
            case 'tts_audio': {
              const audioMsg = msg;
              if (audioMsg.audio) {
                const buf = Buffer.from(audioMsg.audio, 'base64');
                const pcm = new Int16Array(
                  buf.buffer,
                  buf.byteOffset,
                  buf.byteLength / 2,
                );
                if (audioMsg.utterance_id) {
                  this.currentUtteranceId = audioMsg.utterance_id;
                }
                const info = {
                  isFinal: audioMsg.is_final,
                  utteranceId: audioMsg.utterance_id,
                  sequenceId: audioMsg.sequence_id,
                  startMs: audioMsg.start_ms,
                  endMs: audioMsg.end_ms,
                };
                this.listeners.forEach((l) => l(pcm, info));
                if (audioMsg.is_final) {
                  this.markCurrentComplete();
                }
              }
              break;
            }
            default:
              break;
          }
        } catch (error) {
          console.error('Error processing TTS message:', error);
        }
      };

      const handleError = (error: Error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) {
          settled = true;
          this.cleanupListeners(
            handleOpen,
            handleMessage,
            handleError,
            handleClose,
          );
          reject(err);
        } else {
          console.error('Fish Audio TTS websocket error:', err);
        }
      };

      const handleClose = () => {
        this.ready = false;
        this.sessionId = undefined;
        this.stopKeepAlive();
        if (!settled) {
          settled = true;
          this.cleanupListeners(
            handleOpen,
            handleMessage,
            handleError,
            handleClose,
          );
          reject(new Error('Fish Audio TTS websocket closed before ready'));
        } else if (this.shouldReconnect) {
          console.warn(
            'Fish Audio TTS websocket closed; intentando reconectar…',
          );
          this.scheduleReconnect();
        }
      };

      this.ws.once('open', handleOpen);
      this.ws.on('message', handleMessage);
      this.ws.on('error', handleError);
      this.ws.once('close', handleClose);
    });
  }

  onAudio(
    cb: (
      pcm: Int16Array,
      info: {
        isFinal?: boolean;
        utteranceId?: string;
        sequenceId?: number;
        startMs?: number;
        endMs?: number;
      },
    ) => void,
  ) {
    this.listeners.push(cb);
  }
  sendText(
    text: string,
    options?: {
      utteranceId?: string;
      sequenceId?: number;
      priority?: number;
      metadata?: Record<string, unknown>;
      emotion?: string;
      style?: string;
      speed?: number;
      pitch?: number;
      volume?: number;
      textType?: 'plain' | 'ssml';
      latency?: string;
      format?: string;
      extrasJson?: string;
    },
  ): string {
    const utteranceId = options?.utteranceId ?? randomUUID();
    const priority = options?.priority ?? 0;
    const item: QueuedTtsItem = {
      utteranceId,
      text,
      sequenceId: options?.sequenceId,
      priority,
      metadata: options?.metadata,
      submittedAt: Date.now(),
      emotion: options?.emotion ?? this.defaultEmotion,
      style: options?.style ?? this.defaultStyle,
      speed: options?.speed ?? this.defaultSpeed,
      pitch: options?.pitch ?? this.defaultPitch,
      volume: options?.volume ?? this.defaultVolume,
      textType: options?.textType ?? this.defaultTextType,
      latency: options?.latency ?? this.defaultLatency,
      format: options?.format ?? this.defaultFormat,
      extras: mergeExtras(this.textExtras, options?.extrasJson),
    };

    this.queue.push(item);
    this.queue.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.submittedAt - b.submittedAt;
    });

    if (priority > this.currentPriority && this.currentUtteranceId) {
      this.cancelUtterance(
        this.currentUtteranceId,
        'preempted-by-priority',
        'current',
      );
    }

    this.processQueue();

    return utteranceId;
  }

  cancelUtterance(
    utteranceId?: string,
    reason?: string,
    scope: 'current' | 'pending' | 'all' = 'current',
  ) {
    if (scope === 'all') {
      this.queue = [];
      this.currentUtteranceId = undefined;
      this.currentPriority = Number.NEGATIVE_INFINITY;
    } else if (scope === 'pending' && utteranceId) {
      this.queue = this.queue.filter(
        (item) => item.utteranceId !== utteranceId,
      );
    }

    if (!utteranceId && scope === 'current') {
      utteranceId = this.currentUtteranceId;
    }

    if (utteranceId) {
      this.queue = this.queue.filter(
        (item) => item.utteranceId !== utteranceId,
      );
    }

    if (utteranceId && utteranceId === this.currentUtteranceId) {
      this.currentUtteranceId = undefined;
      this.currentPriority = Number.NEGATIVE_INFINITY;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload: FishTtsCancel = {
        type: 'tts_cancel',
        ...(utteranceId ? { utterance_id: utteranceId } : {}),
        scope,
        reason,
      };

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        console.error('Error enviando cancelación a TTS:', error);
      }
    } else {
      console.warn('TTS WebSocket no listo para cancelar.');
    }

    this.processQueue();
  }

  cancelAll(reason?: string) {
    this.cancelUtterance(undefined, reason, 'all');
  }
  onModuleDestroy() {
    if (this.ws) {
      try {
        this.shouldReconnect = false;
        this.ready = false;
        this.sessionId = undefined;
        this.expectingEnd = false;
        this.queue = [];
        this.currentUtteranceId = undefined;
        this.currentPriority = Number.NEGATIVE_INFINITY;
        this.stopKeepAlive();
        this.clearReconnectTimer();
        this.ws.close();
      } catch (error) {
        console.error('Error closing WebSocket:', error);
      }
    }
  }
  async generateAudioBuffer(
    text: string,
    voiceId?: string,
    language?: string,
  ): Promise<Buffer> {
    try {
      const format = this.defaultFormat || 'mp3';
      const payload: Record<string, unknown> = {
        text,
        format,
        voice_id: voiceId || process.env.FISH_TTS_VOICE_ID!,
        language: language || process.env.FISH_LANG || 'es-ES',
      };
      if (this.defaultLatency) {
        payload.latency = this.defaultLatency;
      }
      if (this.defaultEmotion) {
        payload.emotion = this.defaultEmotion;
      }
      if (this.defaultStyle) {
        payload.style = this.defaultStyle;
      }
      if (typeof this.defaultSpeed === 'number') {
        payload.speed = this.defaultSpeed;
      }
      if (typeof this.defaultPitch === 'number') {
        payload.pitch = this.defaultPitch;
      }
      if (typeof this.defaultVolume === 'number') {
        payload.volume = this.defaultVolume;
      }
      if (this.defaultModel) {
        payload.model = this.defaultModel;
      }
      if (this.defaultTextType) {
        payload.text_type = this.defaultTextType;
      }
      if (this.textExtras && Object.keys(this.textExtras).length) {
        Object.assign(payload, this.textExtras);
      }
      const response = await axios.post(
        'https://api.fish.audio/v1/tts',
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.FISH_API_KEY}`,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
        },
      );

      return Buffer.from(response.data as ArrayBuffer);
    } catch (error: any) {
      console.error(
        '❌ Error generando audio TTS:',
        error?.response?.data || error,
      );
      throw new Error('Error al generar audio con Fish.audio');
    }
  }

  private cleanupListeners(
    handleOpen: () => void,
    handleMessage: (raw: Buffer) => void,
    handleError: (error: Error) => void,
    handleClose: () => void,
  ) {
    this.ws?.off('open', handleOpen);
    this.ws?.off('message', handleMessage);
    this.ws?.off('error', handleError);
    this.ws?.off('close', handleClose);
  }

  private processQueue() {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (this.currentUtteranceId) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const payload: FishTtsText = {
      type: 'tts_text',
      text: next.text,
      utterance_id: next.utteranceId,
    };

    if (typeof next.sequenceId === 'number') {
      payload.sequence_id = next.sequenceId;
    }

    if (typeof next.priority === 'number') {
      payload.priority = next.priority;
    }

    if (next.metadata) {
      payload.metadata = next.metadata;
    }
    if (next.emotion) {
      payload.emotion = next.emotion;
    }
    if (next.style) {
      payload.style = next.style;
    }
    if (typeof next.speed === 'number') {
      payload.speed = next.speed;
    }
    if (typeof next.pitch === 'number') {
      payload.pitch = next.pitch;
    }
    if (typeof next.volume === 'number') {
      payload.volume = next.volume;
    }
    if (next.textType) {
      payload.text_type = next.textType;
    }
    if (next.latency) {
      payload.latency = next.latency;
    }
    if (next.format) {
      payload.format = next.format;
    }
    if (next.extras) {
      Object.assign(payload, next.extras);
    }

    try {
      this.currentUtteranceId = next.utteranceId;
      this.currentPriority = next.priority;
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      console.error('Error enviando texto a TTS:', error);
      this.currentUtteranceId = undefined;
      this.currentPriority = Number.NEGATIVE_INFINITY;
      this.queue.unshift(next);
    }
  }

  private markCurrentComplete() {
    this.currentUtteranceId = undefined;
    this.currentPriority = Number.NEGATIVE_INFINITY;
    this.processQueue();
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    if (!this.ws) return;

    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (error) {
          console.error('Error enviando ping a Fish TTS:', error);
        }
      }
    }, 15000);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
    }
  }

  private scheduleReconnect(customDelay?: number) {
    if (this.reconnectTimer || !this.shouldReconnect) {
      return;
    }

    const delay =
      customDelay ?? Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.shouldReconnect) return;

      console.log(
        `Reintentando conexión a Fish TTS (intento ${this.reconnectAttempts})…`,
      );
      this.connect().catch((error) => {
        console.error('Falló reconexión a Fish TTS:', error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

function toOptionalNumber(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonEnv(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.error(
      'No se pudo parsear configuración JSON para Fish TTS:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {};
}

function mergeExtras(
  base: Record<string, unknown>,
  overrideJson?: string,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...base };
  if (overrideJson) {
    try {
      const override = JSON.parse(overrideJson);
      if (
        override &&
        typeof override === 'object' &&
        !Array.isArray(override)
      ) {
        Object.assign(merged, override as Record<string, unknown>);
      }
    } catch (error) {
      console.error(
        'No se pudo parsear extrasJson en sendText:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}
