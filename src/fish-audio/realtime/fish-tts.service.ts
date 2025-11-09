import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  FishTtsInit,
  FishTtsText,
  FishTtsAudio,
  FishTtsIncoming,
} from './types';
import axios from 'axios';

@Injectable()
export class FishTtsService implements OnModuleDestroy {
  private ws?: WebSocket;
  private listeners: Array<(pcm: Int16Array, isFinal?: boolean) => void> = [];
  private ready = false;
  private sessionId?: string;

  connect(): Promise<void> {
    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
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
        try {
          this.ws!.send(JSON.stringify(init));
        } catch (error) {
          settled = true;
          this.cleanupListeners(handleOpen, handleMessage, handleError, handleClose);
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
                if (!settled) {
                  settled = true;
                  this.ws?.off('open', handleOpen);
                  resolve();
                }
              }
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
              }
              break;
            }
            case 'tts_end':
              this.ready = false;
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
                    msg.reason || 'Fish Audio TTS ended unexpectedly before ready',
                  ),
                );
              }
              break;
            case 'tts_audio': {
              const audioMsg = msg as FishTtsAudio;
              if (audioMsg.audio) {
                const buf = Buffer.from(audioMsg.audio, 'base64');
                const pcm = new Int16Array(
                  buf.buffer,
                  buf.byteOffset,
                  buf.byteLength / 2,
                );
                this.listeners.forEach((l) => l(pcm, audioMsg.is_final));
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
          this.cleanupListeners(handleOpen, handleMessage, handleError, handleClose);
          reject(err);
        } else {
          console.error('Fish Audio TTS websocket error:', err);
        }
      };

      const handleClose = () => {
        this.ready = false;
        this.sessionId = undefined;
        if (!settled) {
          settled = true;
          this.cleanupListeners(handleOpen, handleMessage, handleError, handleClose);
          reject(new Error('Fish Audio TTS websocket closed before ready'));
        }
      };

      this.ws.once('open', handleOpen);
      this.ws.on('message', handleMessage);
      this.ws.on('error', handleError);
      this.ws.once('close', handleClose);
    });
  }

  onAudio(cb: (pcm: Int16Array, isFinal?: boolean) => void) {
    this.listeners.push(cb);
  }
  sendText(text: string) {
    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN) {
      const payload: FishTtsText = { type: 'tts_text', text };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        console.error('Error sending text to TTS:', error);
      }
    } else {
      console.warn('TTS WebSocket no listo; se ignora texto saliente.');
    }
  }
  onModuleDestroy() {
    if (this.ws) {
      try {
        this.ready = false;
        this.sessionId = undefined;
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
      const response = await axios.post(
        'https://api.fish.audio/v1/tts',
        {
          text,
          format: 'mp3',
          voice_id: voiceId || process.env.FISH_TTS_VOICE_ID!,
          language: language || process.env.FISH_LANG || 'es-ES',
        },
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
}
