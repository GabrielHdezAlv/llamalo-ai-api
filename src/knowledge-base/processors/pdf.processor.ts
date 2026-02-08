import { Injectable } from '@nestjs/common';
import { BaseProcessor, ProcessedText } from './base.processor';
import * as fs from 'fs';
import PDFParser from 'pdf2json';

@Injectable()
export class PdfProcessor extends BaseProcessor {
  async extractText(filePath: string): Promise<ProcessedText> {
    try {
      console.log('[PdfProcessor] Starting PDF extraction for:', filePath);

      return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        let text = '';
        let pageCount = 0;

        pdfParser.on('pdfParser_dataError', (errData: any) => {
          console.error(
            '[PdfProcessor] PDF parsing error:',
            errData.parserError,
          );
          reject(
            new Error(`Error parsing PDF: ${errData.parserError || errData}`),
          );
        });

        pdfParser.on('pdfParser_dataReady', (pdfData) => {
          try {
            console.log('[PdfProcessor] PDF data ready, processing pages...');

            if (pdfData.Pages) {
              pageCount = pdfData.Pages.length;

              // Extract text from all pages
              pdfData.Pages.forEach((page) => {
                if (page.Texts) {
                  page.Texts.forEach((textItem) => {
                    if (textItem.R && textItem.R.length > 0) {
                      textItem.R.forEach((r) => {
                        if (r.T) {
                          // Decode hex string and add space
                          const decodedText = decodeURIComponent(r.T);
                          text += decodedText + ' ';
                        }
                      });
                    }
                  });
                }
              });
            }

            const cleanedText = this.cleanText(text.trim());
            const wordCount = this.countWords(cleanedText);
            const fileSize = fs.statSync(filePath).size;

            // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
            const estimatedTokens = Math.ceil(cleanedText.length / 4);
            const maxTokens = parseInt(process.env.MAX_TOKENS || '1000000'); // 1M tokens default
            if (estimatedTokens > maxTokens) {
              throw new Error(
                `El PDF es demasiado grande (${estimatedTokens.toLocaleString()} tokens estimados). Por favor, use un PDF más pequeño. Límite recomendado: ~${maxTokens.toLocaleString()} tokens.`,
              );
            }

            console.log('[PdfProcessor] PDF processed successfully:', {
              pageCount,
              textLength: cleanedText.length,
              wordCount,
              fileSize,
              estimatedTokens,
            });

            resolve({
              text: cleanedText,
              metadata: {
                wordCount,
                pageCount,
                size: fileSize,
              },
            });
          } catch (processingError) {
            console.error(
              '[PdfProcessor] Error processing PDF data:',
              processingError,
            );
            reject(
              new Error(
                `Error processing PDF data: ${processingError.message}`,
              ),
            );
          }
        });

        // Parse the PDF file - try multiple methods
        const pdfBuffer = fs.readFileSync(filePath);
        try {
          (pdfParser as any).parseBuffer(pdfBuffer);
        } catch {
          console.log('[PdfProcessor] parseBuffer failed, trying loadBuffer');
          (pdfParser as any).loadBuffer(pdfBuffer);
        }
      });
    } catch (error) {
      console.error('[PdfProcessor] Unexpected error:', error);
      throw new Error(`Error processing PDF: ${error.message}`);
    }
  }
}
