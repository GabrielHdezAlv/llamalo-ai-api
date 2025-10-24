import { Injectable, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { FishTtsInit, FishTtsText, FishTtsAudio } from './types';

@Injectable()
export class FishTtsService implements OnModuleDestroy {
  private ws?: WebSocket;
  private listeners: Array<(pcm: Int16Array, isFinal?: boolean) => void> = [];

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
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

      this.ws.once('open', () => {
        const init: FishTtsInit = {
          type: 'tts_init',
          voice_id: process.env.FISH_TTS_VOICE_ID!,
          language: process.env.FISH_LANG || 'es-ES',
          sample_rate: 8000,
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
          const msg = JSON.parse(raw.toString()) as FishTtsAudio;
          if (msg.type === 'tts_audio' && msg.audio) {
            const buf = Buffer.from(msg.audio, 'base64');
            const pcm = new Int16Array(
              buf.buffer,
              buf.byteOffset,
              buf.byteLength / 2,
            );
            this.listeners.forEach((l) => l(pcm, msg.is_final));
          }
        } catch (error) {
          console.error('Error processing TTS message:', error);
        }
      });
    });
  }

  onAudio(cb: (pcm: Int16Array, isFinal?: boolean) => void) {
    this.listeners.push(cb);
  }
  sendText(text: string) {
    if (this.ws) {
      const payload: FishTtsText = { type: 'tts_text', text };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        console.error('Error sending text to TTS:', error);
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
