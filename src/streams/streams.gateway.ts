import { WebSocketGateway, OnGatewayInit } from '@nestjs/websockets';
import { Server } from 'ws';
import { ulawToPcm16, pcm16ToUlawB64 } from './audio.utils';
import { FishAsrService } from '../fish-audio/realtime/fish-asr.service';
import { FishTtsService } from '../fish-audio/realtime/fish-tts.service';
import { GptService } from '../llm/gpt.service';

type TwilioMediaIn = { event: 'media'; media: { payload: string } };
type TwilioStart = { event: 'start'; start: unknown };
type TwilioStop = { event: 'stop' };
type TwilioMsg = TwilioMediaIn | TwilioStart | TwilioStop;

interface WebSocketClient {
  send: (data: string) => void;
  on: (event: string, callback: (data: Buffer) => void) => void;
  close: () => void;
}

@WebSocketGateway({ path: '/voice/stream' })
export class StreamsGateway implements OnGatewayInit {
  private speaking = false;
  constructor(
    private readonly asr: FishAsrService,
    private readonly tts: FishTtsService,
    private readonly gpt: GptService,
  ) {}

  afterInit(server: Server) {
    try {
      server.on('connection', async (client: WebSocketClient) => {
        try {
          await Promise.all([this.asr.connect(), this.tts.connect()]);
        } catch (error) {
          console.error('Error connecting services:', error);
          client.close();
          return;
        }

        this.tts.onAudio((pcm: Int16Array) => {
          if (!this.speaking) return;
          const ulawB64 = pcm16ToUlawB64(pcm);
          client.send(
            JSON.stringify({ event: 'media', media: { payload: ulawB64 } }),
          );
        });

        this.asr.onTranscript((t) => {
          const text = (t.text || '').trim();
          if (!text) return;

          // barge-in: si hay voz entrante cortamos TTS
          this.speaking = false;

          if (t.is_final) {
            this.speaking = true;
            void this.handleGptResponse(text);
          }
        });

        client.on('message', (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString()) as TwilioMsg;
            if (msg.event === 'media') {
              this.speaking = false;
              const pcm = ulawToPcm16(msg.media.payload);
              this.asr.sendPcm16(pcm);
            }
            if (msg.event === 'stop') {
              this.asr.stop();
              client.close();
            }
          } catch (error) {
            console.error('Error processing message:', error);
          }
        });
      });
    } catch (error) {
      console.error('Error setting up WebSocket connection:', error);
    }
  }

  private async handleGptResponse(text: string): Promise<void> {
    try {
      let pending = '';
      for await (const token of this.gpt.streamReply(text)) {
        if (!this.speaking) break;
        pending += token;
        const flush = /[.!?]\s$/.test(pending) || pending.length > 120;
        if (flush) {
          this.tts.sendText(pending);
          pending = '';
        }
      }
      if (this.speaking && pending) {
        this.tts.sendText(pending);
      }
    } catch (error) {
      console.error('Error handling GPT response:', error);
    }
  }
}
