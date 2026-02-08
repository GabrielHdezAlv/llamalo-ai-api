import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import * as cheerio from 'cheerio';
import axios from 'axios';

@Injectable()
export class WebScraperProcessor extends BaseProcessor {
  async extractText(url: string): Promise<ProcessedText> {
    try {
      console.log(`[WebScraperProcessor] Processing URL: "${url}"`);
      const response = await axios.get(url, {
        timeout: parseInt(process.env.WEB_SCRAPING_TIMEOUT || '30000'),
        maxContentLength: 5 * 1024 * 1024, // 5MB limit
        maxBodyLength: 5 * 1024 * 1024, // 5MB limit
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const $ = cheerio.load(response.data);

      // Remove unwanted elements
      $(
        'script, style, nav, header, footer, aside, .ads, .menu, .cookie-banner',
      ).remove();

      // Extract main content
      let text = '';

      // Try to find main content areas
      const mainSelectors = [
        'main',
        'article',
        '.content',
        '.main-content',
        '#content',
        '#main',
        'body',
      ];

      for (const selector of mainSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          text = element.text();
          break;
        }
      }

      if (!text) {
        text = $('body').text();
      }

      const cleanedText = this.cleanText(text);
      const wordCount = this.countWords(cleanedText);

      // Validate content size limits
      if (cleanedText.length > 100000) {
        throw new Error(
          'El contenido extraído excede el límite de 100,000 caracteres. Por favor, use una URL más específica o divida el contenido.',
        );
      }

      return {
        text: cleanedText,
        metadata: {
          wordCount,
          size: Buffer.byteLength(response.data, 'utf8'),
        },
      };
    } catch (error) {
      throw new Error(`Error scraping web content: ${error.message}`);
    }
  }
}
