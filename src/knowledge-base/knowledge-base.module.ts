import { Module } from '@nestjs/common';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { EmbeddingsService } from './embeddings/embeddings.service';
import { VectorStoreService } from './embeddings/vector-store.service';
import { PdfProcessor } from './processors/pdf.processor';
import { WebScraperProcessor } from './processors/web-scraper.processor';
import { TextProcessor } from './processors/text.processor';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

@Module({
  imports: [
    MulterModule.register({
      storage: diskStorage({
        destination: './uploads/knowledge-base',
        filename: (req, file, cb) => {
          const randomName = Date.now() + '-' + Math.round(Math.random() * 1E9);
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
          cb(null, true);
        } else {
          cb(new Error('Only PDF files are allowed'), false);
        }
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
      },
    }),
  ],
  controllers: [KnowledgeBaseController],
  providers: [
    KnowledgeBaseService,
    EmbeddingsService,
    VectorStoreService,
    PdfProcessor,
    WebScraperProcessor,
    TextProcessor,
  ],
  exports: [
    KnowledgeBaseService,
    EmbeddingsService,
    VectorStoreService,
  ],
})
export class KnowledgeBaseModule {}
