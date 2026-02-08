import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import * as cheerio from 'cheerio';
import axios from 'axios';

@Injectable()
export class WebScraperProcessor extends BaseProcessor {
  async extractText(url: string): Promise<ProcessedText> {
    try {
      console.log(`[WebScraperProcessor] Processing URL: "${url}"`);

      // Clean and validate URL
      let cleanUrl = url.trim();

      // Fix common URL issues
      if (cleanUrl.includes('https://https://')) {
        cleanUrl = cleanUrl.replace('https://https://', 'https://');
        console.log(
          `[WebScraperProcessor] Fixed duplicate protocol: "${cleanUrl}"`,
        );
      }
      if (cleanUrl.includes('http://http://')) {
        cleanUrl = cleanUrl.replace('http://http://', 'http://');
        console.log(
          `[WebScraperProcessor] Fixed duplicate protocol: "${cleanUrl}"`,
        );
      }

      // Basic URL validation
      try {
        new URL(cleanUrl);
      } catch {
        throw new Error(
          `URL inválida: ${cleanUrl}. Asegúrese de que la URL sea válida y comience con http:// o https://`,
        );
      }

      const response = await axios.get(cleanUrl, {
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
      const maxCharacters = parseInt(
        process.env.MAX_CONTENT_CHARACTERS || '500000',
      ); // 500K chars default
      if (cleanedText.length > maxCharacters) {
        throw new Error(
          `El contenido extraído excede el límite de ${maxCharacters.toLocaleString()} caracteres. Por favor, use una URL más específica o divida el contenido.`,
        );
      }

      // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
      const estimatedTokens = Math.ceil(cleanedText.length / 4);
      const maxTokens = parseInt(process.env.MAX_TOKENS || '1000000'); // 1M tokens default
      if (estimatedTokens > maxTokens) {
        throw new Error(
          `El contenido es demasiado grande (${estimatedTokens.toLocaleString()} tokens estimados). Por favor, use una URL más específica con menos contenido. Límite recomendado: ~${maxTokens.toLocaleString()} tokens.`,
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
