import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';

@Injectable()
export class TextProcessor extends BaseProcessor {
  extractText(content: string): Promise<ProcessedText> {
    return new Promise((resolve, reject) => {
      try {
        const cleanedText = this.cleanText(content);
        const wordCount = this.countWords(cleanedText);

        // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
        const estimatedTokens = Math.ceil(cleanedText.length / 4);
        const maxTokens = parseInt(process.env.MAX_TOKENS || '1000000'); // 1M tokens default
        if (estimatedTokens > maxTokens) {
          reject(
            new Error(
              `El texto es demasiado grande (${estimatedTokens.toLocaleString()} tokens estimados). Por favor, use un texto más pequeño. Límite recomendado: ~${maxTokens.toLocaleString()} tokens.`,
            ),
          );
          return;
        }

        resolve({
          text: cleanedText,
          metadata: {
            wordCount,
            size: Buffer.byteLength(content, 'utf8'),
            estimatedTokens,
          },
        });
      } catch (error) {
        reject(new Error(`Error processing text: ${error.message}`));
      }
    });
  }
}
