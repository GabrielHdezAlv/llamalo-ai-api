import { Injectable, Logger } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import axios from 'axios';
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';

@Injectable()
export class WebScraperProcessor extends BaseProcessor {
  private readonly logger = new Logger(WebScraperProcessor.name);

  private readonly puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080',
  ];

  async extractText(url: string): Promise<ProcessedText> {
    let browser: Browser | null = null;
    try {
      this.logger.log(`[WebScraperProcessor] Processing URL: "${url}"`);

      let cleanUrl = url.trim();
      if (cleanUrl.includes('https://https://')) {
        cleanUrl = cleanUrl.replace('https://https://', 'https://');
      }
      if (cleanUrl.includes('http://http://')) {
        cleanUrl = cleanUrl.replace('http://http://', 'http://');
      }

      try {
        new URL(cleanUrl);
      } catch {
        throw new Error(
          `URL inválida: ${cleanUrl}. Asegúrese de que la URL sea válida y comience con http:// o https://`,
        );
      }

      this.logger.log(`[WebScraperProcessor] Launching browser for: ${cleanUrl}`);

      try {
        browser = await this.launchPuppeteerBrowser();
      } catch (launchErr) {
        const msg =
          launchErr instanceof Error ? launchErr.message : String(launchErr);
        this.logger.warn(
          `[WebScraperProcessor] No se pudo iniciar el navegador (${msg}). Usando descarga HTTP como respaldo.`,
        );
        return this.extractTextViaHttp(cleanUrl);
      }

      const page = await browser.newPage();

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      );

      const timeout = parseInt(process.env.WEB_SCRAPING_TIMEOUT || '30000', 10);

      try {
        await page.goto(cleanUrl, {
          waitUntil: 'networkidle2',
          timeout: timeout,
        });
      } catch (gotoError) {
        this.logger.warn(
          `[WebScraperProcessor] networkidle2 failed, trying load event: ${gotoError instanceof Error ? gotoError.message : gotoError}`,
        );
        await page.goto(cleanUrl, {
          waitUntil: 'load',
          timeout: timeout,
        });
      }

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

      const html = await page.content();
      const pageTitle = await page.title();
      return this.buildProcessedTextFromHtml(html, cleanUrl, pageTitle);
    } catch (error) {
      this.logger.error(
        `Error scraping web content from ${url}: ${error instanceof Error ? error.message : error}`,
      );
      throw new Error(
        `Error al procesar la web: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          this.logger.error(
            `Error closing browser: ${closeError instanceof Error ? closeError.message : closeError}`,
          );
        }
      }
    }
  }

  /**
   * Puppeteer 24+ espera Chrome for Testing (cache). Si no está instalado
   * (p. ej. PUPPETEER_SKIP_DOWNLOAD) o falla la ruta, probamos Chrome del sistema.
   */
  private async launchPuppeteerBrowser(): Promise<Browser> {
    const base = {
      headless: true,
      args: this.puppeteerArgs,
    } as const;

    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    if (envPath) {
      this.logger.log(
        `[WebScraperProcessor] Usando PUPPETEER_EXECUTABLE_PATH: ${envPath}`,
      );
      return puppeteer.launch({ ...base, executablePath: envPath });
    }

    try {
      const bundled = puppeteer.executablePath();
      if (bundled) {
        return await puppeteer.launch({ ...base, executablePath: bundled });
      }
    } catch (e) {
      this.logger.warn(
        `[WebScraperProcessor] Chromium empaquetado no disponible: ${e instanceof Error ? e.message : e}`,
      );
    }

    try {
      this.logger.log(
        '[WebScraperProcessor] Intentando Chrome instalado en el sistema (channel: chrome)...',
      );
      return await puppeteer.launch({
        ...base,
        channel: 'chrome',
      });
    } catch (e) {
      this.logger.warn(
        `[WebScraperProcessor] channel chrome falló: ${e instanceof Error ? e.message : e}`,
      );
    }

    return puppeteer.launch({ ...base });
  }

  /**
   * Respaldo sin motor: muchas páginas (p. ej. Wikipedia) sirven HTML suficiente para Readability.
   */
  private async extractTextViaHttp(cleanUrl: string): Promise<ProcessedText> {
    const timeout = parseInt(process.env.WEB_SCRAPING_TIMEOUT || '30000', 10);
    const { data } = await axios.get<string>(cleanUrl, {
      timeout,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });

    if (typeof data !== 'string' || data.trim().length < 10) {
      throw new Error(
        'La respuesta HTTP no contiene HTML suficiente. Instala Chrome o ejecuta: npx puppeteer browsers install chrome',
      );
    }

    try {
      return this.buildProcessedTextFromHtml(data, cleanUrl);
    } catch (e) {
      throw new Error(
        `No se pudo extraer texto con el respaldo HTTP: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private buildProcessedTextFromHtml(
    html: string,
    cleanUrl: string,
    titleHint?: string,
  ): ProcessedText {
    const dom = new JSDOM(html, { url: cleanUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length < 10) {
      const bodyText = dom.window.document.body?.innerText ?? '';
      if (!bodyText || bodyText.trim().length < 10) {
        throw new Error(
          'No se pudo extraer contenido de la página web. Es posible que el sitio bloquee el acceso o requiera autenticación.',
        );
      }

      const cleanedText = this.cleanText(bodyText);
      return {
        text: cleanedText,
        metadata: {
          wordCount: this.countWords(cleanedText),
          size: Buffer.byteLength(html, 'utf8'),
          title: titleHint ?? dom.window.document.title ?? undefined,
        },
      };
    }

    const fullText = `${article.title}\n\n${article.textContent}`;
    const cleanedText = this.cleanText(fullText);
    const wordCount = this.countWords(cleanedText);

    const maxCharacters = parseInt(
      process.env.MAX_CONTENT_CHARACTERS || '500000',
      10,
    );
    if (cleanedText.length > maxCharacters) {
      throw new Error(
        `El contenido extraído excede el límite de ${maxCharacters.toLocaleString()} caracteres.`,
      );
    }

    this.logger.log(
      `[WebScraperProcessor] Successfully processed URL: ${cleanUrl} (${wordCount} words)`,
    );

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
  }
}
