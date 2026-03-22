import { Injectable, Logger } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as puppeteer from 'puppeteer';

@Injectable()
export class WebScraperProcessor extends BaseProcessor {
  private readonly logger = new Logger(WebScraperProcessor.name);

  async extractText(url: string): Promise<ProcessedText> {
    let browser: puppeteer.Browser | null = null;
    try {
      this.logger.log(`[WebScraperProcessor] Processing URL: "${url}"`);

      // Clean and validate URL
      let cleanUrl = url.trim();

      // Fix common URL issues
      if (cleanUrl.includes('https://https://')) {
        cleanUrl = cleanUrl.replace('https://https://', 'https://');
      }
      if (cleanUrl.includes('http://http://')) {
        cleanUrl = cleanUrl.replace('http://http://', 'http://');
      }

      // Basic URL validation
      try {
        new URL(cleanUrl);
      } catch {
        throw new Error(
          `URL inválida: ${cleanUrl}. Asegúrese de que la URL sea válida y comience con http:// o https://`,
        );
      }

      this.logger.log(`[WebScraperProcessor] Launching browser for: ${cleanUrl}`);
      
      // Launch puppeteer with optimized settings
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
      });

      const page = await browser.newPage();
      
      // Set a realistic user agent
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      );

      // Set timeout for navigation
      const timeout = parseInt(process.env.WEB_SCRAPING_TIMEOUT || '30000');
      
      try {
        await page.goto(cleanUrl, {
          waitUntil: 'networkidle2',
          timeout: timeout,
        });
      } catch (gotoError) {
        this.logger.warn(`[WebScraperProcessor] networkidle2 failed, trying load event: ${gotoError.message}`);
        await page.goto(cleanUrl, {
          waitUntil: 'load',
          timeout: timeout,
        });
      }

      // Scroll to bottom to trigger lazy loading if any
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 100;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= scrollHeight || totalHeight > 5000) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });

      // Get the rendered HTML content
      const html = await page.content();
      
      // Use JSDOM and Readability to extract the main article content
      const dom = new JSDOM(html, { url: cleanUrl });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article || !article.textContent || article.textContent.trim().length < 10) {
        // Fallback: if readability fails, try to get body text directly
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (!bodyText || bodyText.trim().length < 10) {
          throw new Error('No se pudo extraer contenido de la página web. Es posible que el sitio bloquee el acceso o requiera autenticación.');
        }
        
        const cleanedText = this.cleanText(bodyText);
        return {
          text: cleanedText,
          metadata: {
            wordCount: this.countWords(cleanedText),
            size: Buffer.byteLength(html, 'utf8'),
            title: await page.title(),
          },
        };
      }

      const fullText = `${article.title}\n\n${article.textContent}`;
      const cleanedText = this.cleanText(fullText);
      const wordCount = this.countWords(cleanedText);

      // Validate content size limits
      const maxCharacters = parseInt(
        process.env.MAX_CONTENT_CHARACTERS || '500000',
      );
      if (cleanedText.length > maxCharacters) {
        throw new Error(
          `El contenido extraído excede el límite de ${maxCharacters.toLocaleString()} caracteres.`,
        );
      }

      this.logger.log(`[WebScraperProcessor] Successfully processed URL: ${cleanUrl} (${wordCount} words)`);

      return {
        text: cleanedText,
        metadata: {
          wordCount,
          size: Buffer.byteLength(html, 'utf8'),
          title: article.title,
          excerpt: article.excerpt,
          byline: article.byline,
          siteName: article.siteName,
        },
      };
    } catch (error) {
      this.logger.error(`Error scraping web content from ${url}: ${error.message}`);
      throw new Error(`Error al procesar la web: ${error.message}`);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          this.logger.error(`Error closing browser: ${closeError.message}`);
        }
      }
    }
  }
}
