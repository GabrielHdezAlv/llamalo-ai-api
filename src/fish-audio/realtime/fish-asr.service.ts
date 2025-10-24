import { Injectable, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import {
  FishAsrInit,
  FishAsrAudio,
  FishAsrStop,
  FishAsrTranscript,
} from './types';

@Injectable()
export class FishAsrService implements OnModuleDestroy {
  private ws?: WebSocket;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.fish.audio/realtime/asr';
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

      this.ws.once('open', () => {
        const init: FishAsrInit = {
          type: 'asr_init',
          sample_rate: 8000,
          language: process.env.FISH_LANG || 'es-ES',
        };
        try {
          this.ws!.send(JSON.stringify(init));
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.ws.once('error', (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as FishAsrTranscript;
          if (msg.type === 'asr_transcript' && this.onCb) {
            this.onCb(msg);
          }
        } catch (error) {
          console.error('Error parsing ASR message:', error);
        }
      });
    });
  }

  private onCb?: (t: FishAsrTranscript) => void;
  onTranscript(cb: (t: FishAsrTranscript) => void) {
    this.onCb = cb;
  }

  sendPcm16(pcm: Int16Array) {
    if (this.ws) {
      const audio: FishAsrAudio = {
        type: 'asr_audio',
        audio: Buffer.from(new Int16Array(pcm).buffer).toString('base64'),
      };
      try {
        this.ws.send(JSON.stringify(audio));
      } catch (error) {
        console.error('Error sending audio to ASR:', error);
      }
    }
  }

  stop() {
    if (this.ws) {
      const s: FishAsrStop = {
        type: 'asr_stop',
      };
      try {
        this.ws.send(JSON.stringify(s));
      } catch (error) {
        console.error('Error sending stop to ASR:', error);
      }
    }
  }
  onModuleDestroy() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('Error closing WebSocket:', error);
      }
    }
  }
}
