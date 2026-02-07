import { Injectable } from '@nestjs/common';

export interface ProcessedText {
  text: string;
  metadata: {
    wordCount: number;
    pageCount?: number;
    size?: number;
  };
}

@Injectable()
export abstract class BaseProcessor {
  abstract extractText(input: any): Promise<ProcessedText>;
  
  protected countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }
  
  protected cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
  }
}
