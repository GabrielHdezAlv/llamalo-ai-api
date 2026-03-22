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
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
      });

      const $ = cheerio.load(response.data);

      // Extract title for metadata
      const pageTitle =
        $('title').text().trim() ||
        $('h1').first().text().trim() ||
        'Página web';

      // Remove unwanted elements more aggressively
      $(
        'script, style, nav, header, footer, aside, .ads, .menu, .cookie-banner, ' +
          'noscript, .social, .sharing, .footer-widgets, #sidebar, .sidebar, .widget, ' +
          '.banner, .popup, .modal, .cookie-consent, iframe, svg, canvas, button, ' +
          '[role="navigation"], [role="banner"], [role="contentinfo"]',
      ).remove();

      // Extract main content
      let extractedText = '';

      // Main content candidates with priority
      const mainSelectors = [
        'article',
        'main',
        '[role="main"]',
        '.content',
        '.post-content',
        '.article-content',
        '#content',
        '#main',
        '.main-content',
        '.page-content',
      ];

      // Try to find the candidate with the most text
      let bestContent = '';
      let maxLen = 0;

      for (const selector of mainSelectors) {
        $(selector).each((_, el) => {
          const content = $(el).text().trim();
          if (content.length > maxLen) {
            maxLen = content.length;
            bestContent = content;
          }
        });
        // If we found a very good candidate (like an article), stop
        if (maxLen > 1000 && (selector === 'article' || selector === 'main')) {
          break;
        }
      }

      extractedText = bestContent || $('body').text();

      // Clean the extracted text further
      const cleanedText = this.cleanText(extractedText);
      const wordCount = this.countWords(cleanedText);

      // Validate content size limits
      const maxCharacters = parseInt(
        process.env.MAX_CONTENT_CHARACTERS || '1000000',
      ); // Aumentado a 1M para webs ricas
      if (cleanedText.length > maxCharacters) {
        throw new Error(
          `El contenido extraído excede el límite de ${maxCharacters.toLocaleString()} caracteres.`,
        );
      }

      // Estimate tokens
      const estimatedTokens = Math.ceil(cleanedText.length / 4);

      return {
        text: `Título: ${pageTitle}\n\nContenido:\n${cleanedText}`,
        metadata: {
          wordCount: wordCount + this.countWords(pageTitle),
          size: Buffer.byteLength(response.data, 'utf8'),
          title: pageTitle,
          url: cleanUrl,
        },
      };
    } catch (error) {
      throw new Error(`Error scraping web content: ${error.message}`);
    }
  }
}
