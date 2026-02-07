import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';

@Injectable()
export class TextProcessor extends BaseProcessor {
  async extractText(content: string): Promise<ProcessedText> {
    try {
      const cleanedText = this.cleanText(content);
      const wordCount = this.countWords(cleanedText);
      
      return {
        text: cleanedText,
        metadata: {
          wordCount,
          size: Buffer.byteLength(content, 'utf8'),
        },
      };
    } catch (error) {
      throw new Error(`Error processing text: ${error.message}`);
    }
  }
}
