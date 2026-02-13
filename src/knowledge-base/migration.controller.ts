import { Controller, Post, Body } from '@nestjs/common';
import { KnowledgeBaseService } from './knowledge-base.service';
import { VectorStoreService } from './embeddings/vector-store.service';
import { EmbeddingsService } from './embeddings/embeddings.service';
import { TextChunker } from './utils/chunker';
import { Logger } from '@nestjs/common';

@Controller('migration')
export class MigrationController {
  private readonly logger = new Logger(MigrationController.name);

  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly vectorStoreService: VectorStoreService,
    private readonly embeddingsService: EmbeddingsService,
  ) {}

  @Post('migrate-source')
  async migrateSource(@Body() body: { sourceId: string; content: string }) {
    try {
      const { sourceId, content } = body;

      this.logger.log(`🔄 Migrando fuente ${sourceId}...`);

      // Crear chunks del contenido
      const textChunker = new TextChunker(1000, 200);
      const chunks = textChunker.createChunks(content, sourceId);

      this.logger.log(`📝 Creados ${chunks.length} chunks`);

      // Generar embeddings
      const chunkTexts = chunks.map((chunk) => chunk.content);
      const embeddings =
        await this.embeddingsService.generateBatchEmbeddings(chunkTexts);

      this.logger.log(`🔢 Generados ${embeddings.length} embeddings`);

      // Guardar en vector store (ahora con persistencia en Firestore)
      await this.vectorStoreService.storeChunks(sourceId, chunks, embeddings);

      this.logger.log(`✅ Fuente ${sourceId} migrada exitosamente`);

      return {
        success: true,
        message: `Fuente ${sourceId} migrada exitosamente`,
        chunksCount: chunks.length,
        embeddingsCount: embeddings.length,
      };
    } catch (error) {
      this.logger.error(`❌ Error migrando fuente: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
