import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  FishAsrInit,
  FishAsrAudio,
  FishAsrStop,
  FishAsrTranscript,
  FishAsrIncoming,
  FishAsrStopNotice,
  FishAsrCloseNotice,
} from './types';

@Injectable()
export class FishAsrService implements OnModuleDestroy {
  private ws?: WebSocket;
  private ready = false;
  private sessionId?: string;
  private keepAliveInterval?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private expectingStop = false;

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

      const url = 'wss://api.fish.audio/realtime/asr';
      try {
        this.ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}` },
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let settled = false;

      const handleOpen = () => {
        const init: FishAsrInit = {
          type: 'asr_init',
          sample_rate: 8000,
          language: process.env.FISH_LANG || 'es-ES',
          encoding: 'pcm16',
          session_id: sessionId,
          enable_intermediate_results: true,
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
          const msg = JSON.parse(raw.toString()) as FishAsrIncoming;
          switch (msg.type) {
            case 'asr_ready':
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
              break;
            case 'asr_error': {
              const errorMessage =
                msg.error || 'Fish Audio ASR reported an unknown error';
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
                console.error('Fish Audio ASR error:', errorMessage);
              }
              break;
            }
            case 'asr_transcript':
              if (this.onCb && this.ready) {
                this.onCb(msg as FishAsrTranscript);
              }
              break;
            case 'asr_stop': {
              const stopMsg = msg as FishAsrStopNotice;
              console.log(
                `Fish Audio ASR indicó stop${
                  stopMsg.reason ? `: ${stopMsg.reason}` : ''
                }`,
              );
              this.ready = false;
              this.stopKeepAlive();
              const wasExpected = this.expectingStop;
              this.expectingStop = false;
              if (this.shouldReconnect) {
                // Reconectar para mantener la sesión fresca
                this.scheduleReconnect(wasExpected ? 1000 : undefined);
              }
              break;
            }
            case 'asr_close': {
              const closeMsg = msg as FishAsrCloseNotice;
              console.log(
                `Fish Audio ASR cerró la sesión${
                  closeMsg.reason ? `: ${closeMsg.reason}` : ''
                }`,
              );
              this.ready = false;
              this.stopKeepAlive();
              const wasExpected = this.expectingStop;
              this.expectingStop = false;
              if (this.shouldReconnect) {
                this.scheduleReconnect(wasExpected ? 1000 : undefined);
              }
              break;
            }
            default:
              break;
          }
        } catch (error) {
          console.error('Error parsing ASR message:', error);
        }
      };

      const handleError = (error: Error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) {
          settled = true;
          this.cleanupListeners(handleOpen, handleMessage, handleError, handleClose);
          reject(err);
        } else {
          console.error('Fish Audio ASR websocket error:', err);
        }
      };

      const handleClose = () => {
        this.ready = false;
        this.sessionId = undefined;
        this.stopKeepAlive();
        if (!settled) {
          settled = true;
          this.cleanupListeners(handleOpen, handleMessage, handleError, handleClose);
          reject(new Error('Fish Audio ASR websocket closed before ready'));
        } else if (this.shouldReconnect) {
          console.warn('Fish Audio ASR websocket closed; intentando reconectar…');
          this.scheduleReconnect();
        }
      };

      this.ws.once('open', handleOpen);
      this.ws.on('message', handleMessage);
      this.ws.on('error', handleError);
      this.ws.once('close', handleClose);
    });
  }

  private onCb?: (t: FishAsrTranscript) => void;
  onTranscript(cb: (t: FishAsrTranscript) => void) {
    this.onCb = cb;
  }

  sendPcm16(pcm: Int16Array) {
    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN) {
      const audio: FishAsrAudio = {
        type: 'asr_audio',
        audio: Buffer.from(new Int16Array(pcm).buffer).toString('base64'),
      };
      try {
        this.ws.send(JSON.stringify(audio));
      } catch (error) {
        console.error('Error sending audio to ASR:', error);
      }
    } else {
      console.warn('ASR WebSocket no listo; se ignora audio saliente.');
    }
  }

  stop() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const s: FishAsrStop = {
        type: 'asr_stop',
      };
      try {
        this.expectingStop = true;
        this.ws.send(JSON.stringify(s));
      } catch (error) {
        console.error('Error sending stop to ASR:', error);
      }
    }
  }
  onModuleDestroy() {
    if (this.ws) {
      try {
        this.shouldReconnect = false;
        this.ready = false;
        this.sessionId = undefined;
        this.expectingStop = false;
        this.stopKeepAlive();
        this.clearReconnectTimer();
        this.ws.close();
      } catch (error) {
        console.error('Error closing WebSocket:', error);
      }
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

  private startKeepAlive() {
    this.stopKeepAlive();
    if (!this.ws) return;

    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (error) {
          console.error('Error enviando ping a Fish ASR:', error);
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
        `Reintentando conexión a Fish ASR (intento ${this.reconnectAttempts})…`,
      );
      this.connect().catch((error) => {
        console.error('Falló reconexión a Fish ASR:', error);
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
