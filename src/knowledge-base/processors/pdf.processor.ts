import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import * as fs from 'fs';
const pdfParse = require('pdf-parse');

@Injectable()
export class PdfProcessor extends BaseProcessor {
  async extractText(filePath: string): Promise<ProcessedText> {
    try {
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
