import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import * as fs from 'fs';

@Injectable()
export class PdfProcessor extends BaseProcessor {
  async extractText(filePath: string): Promise<ProcessedText> {
    try {
      // Dynamic import for pdf-parse
      const pdfParseModule = await import('pdf-parse');
      const pdfParse =
        (pdfParseModule as any).default || (pdfParseModule as any);

      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);

      const cleanedText = this.cleanText(data.text);
      const wordCount = this.countWords(cleanedText);

      return {
        text: cleanedText,
        metadata: {
          wordCount,
          pageCount: data.numpages,
          size: fs.statSync(filePath).size,
        },
      };
    } catch (error) {
      throw new Error(`Error processing PDF: ${error.message}`);
    }
  }
}
