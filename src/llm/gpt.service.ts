import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class GptService {
  private readonly logger = new Logger(GptService.name);
  private readonly openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  private readonly model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  private readonly temperature = Number(process.env.OPENAI_TEMPERATURE ?? 0.7);

  async *streamReply(userInput: string): AsyncGenerator<string> {
    const stream = await this.openai.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      stream: true,
      messages: [{ role: 'user', content: userInput }],
    });
    for await (const ev of stream) {
      const delta = ev.choices?.[0]?.delta?.content ?? '';
      if (delta) yield delta;
    }
  }

  async getReply(userInput: string): Promise<string> {
    try {
      const r = await this.openai.chat.completions.create({
        model: this.model,
        temperature: this.temperature,
        messages: [{ role: 'user', content: userInput }],
      });
      return r.choices?.[0]?.message?.content?.trim() || '';
    } catch (e) {
      this.logger.error('Error GPT', e);
      return 'Lo siento, ahora no puedo responder.';
    }
  }
}
