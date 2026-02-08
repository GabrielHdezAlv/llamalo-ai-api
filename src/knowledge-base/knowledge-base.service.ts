import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { getFirestore } from '../firebase/firebase.config';
import {
  CreateKnowledgeSourceDto,
  UpdateKnowledgeSourceDto,
  KnowledgeSourceDto,
  SearchKnowledgeDto,
  KnowledgeSourceType,
  KnowledgeSourceStatus,
  LinkKnowledgeToAgentDto,
} from './dto/knowledge-source.dto';
import { PdfProcessor } from './processors/pdf.processor';
import { WebScraperProcessor } from './processors/web-scraper.processor';
import { TextProcessor } from './processors/text.processor';
import { EmbeddingsService } from './embeddings/embeddings.service';
import { VectorStoreService } from './embeddings/vector-store.service';
import { TextChunker } from './utils/chunker';
import { TextCleaner } from './utils/text-cleaner';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class KnowledgeBaseService {
  private readonly firestore = getFirestore();
  private readonly logger = new Logger(KnowledgeBaseService.name);
  private readonly textChunker = new TextChunker(
    parseInt(process.env.CHUNK_SIZE || '1000'),
    parseInt(process.env.CHUNK_OVERLAP || '200'),
  );
  private readonly textCleaner = new TextCleaner();

  constructor(
    private readonly pdfProcessor: PdfProcessor,
    private readonly webScraperProcessor: WebScraperProcessor,
    private readonly textProcessor: TextProcessor,
    private readonly embeddingsService: EmbeddingsService,
    private readonly vectorStoreService: VectorStoreService,
  ) {}

  async createKnowledgeSource(
    userId: string,
    createSourceDto: CreateKnowledgeSourceDto,
    filePath?: string,
  ): Promise<KnowledgeSourceDto> {
    try {
      const sourceId = `src_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const knowledgeSource = {
        id: sourceId,
        userId,
        name: createSourceDto.name,
        type: createSourceDto.type,
        status: KnowledgeSourceStatus.PROCESSING,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          chunkCount: 0,
        },
        tags: createSourceDto.tags || [],
        isPublic: createSourceDto.isPublic || false,
        ...(createSourceDto.url && { originalUrl: createSourceDto.url }),
        ...(filePath && { fileName: path.basename(filePath) }),
      };

      // Create initial record in Firestore
      await this.firestore
        .collection('knowledgeSources')
        .doc(sourceId)
        .set(knowledgeSource);

      // Start async processing
      void this.processKnowledgeSource(
        sourceId,
        createSourceDto,
        filePath,
      ).catch((error) => {
        this.logger.error(
          `Error processing source ${sourceId}: ${error.message}`,
        );
        void this.updateSourceStatus(sourceId, KnowledgeSourceStatus.FAILED);
      });

      return this.mapToDto(knowledgeSource);
    } catch (error) {
      this.logger.error(`Error creating knowledge source: ${error.message}`);
      throw new BadRequestException(
        `Failed to create knowledge source: ${error.message}`,
      );
    }
  }

  private async processKnowledgeSource(
    sourceId: string,
    createSourceDto: CreateKnowledgeSourceDto,
    filePath?: string,
  ): Promise<void> {
    try {
      this.logger.log(
        `[KnowledgeBaseService] Starting processing for source: ${sourceId}`,
      );

      let processedText;

      // Extract text based on type
      switch (createSourceDto.type) {
        case KnowledgeSourceType.PDF:
          if (!filePath) {
            throw new Error('File path is required for PDF processing');
          }
          this.logger.log(
            `[KnowledgeBaseService] Extracting text from PDF: ${filePath}`,
          );
          processedText = await this.pdfProcessor.extractText(filePath);
          this.logger.log(
            `[KnowledgeBaseService] Text extracted successfully, length: ${processedText.text.length}`,
          );
          break;
        case KnowledgeSourceType.WEB:
          if (!createSourceDto.url) {
            throw new Error('URL is required for web processing');
          }
          processedText = await this.webScraperProcessor.extractText(
            createSourceDto.url,
          );
          break;
        case KnowledgeSourceType.TEXT:
          if (!createSourceDto.content) {
            throw new Error('Content is required for text processing');
          }
          processedText = await this.textProcessor.extractText(
            createSourceDto.content,
          );
          break;
        default:
          throw new Error(
            `Unsupported source type: ${createSourceDto.type as string}`,
          );
      }

      // Clean text
      const cleanedText = this.textCleaner.clean(processedText.text as string);

      this.logger.log(`[KnowledgeBaseService] Creating chunks from text...`);
      // Split text into chunks
      const chunks = this.textChunker.createChunks(cleanedText, sourceId);
      this.logger.log(`[KnowledgeBaseService] Created ${chunks.length} chunks`);

      this.logger.log(`[KnowledgeBaseService] Generating embeddings...`);
      // Generate embeddings
      const chunkTexts = chunks.map((chunk) => chunk.content);

      // Process embeddings in batches to handle large content
      const allEmbeddings: number[][] = [];

      for (let i = 0; i < chunkTexts.length; i += 100) {
        // Process 100 chunks at a time
        const batch = chunkTexts.slice(i, i + 100);
        this.logger.log(
          `[KnowledgeBaseService] Processing batch ${Math.floor(i / 100) + 1}/${Math.ceil(chunkTexts.length / 100)} (${batch.length} chunks)`,
        );

        try {
          const batchEmbeddings =
            await this.embeddingsService.generateBatchEmbeddings(batch);
          allEmbeddings.push(...batchEmbeddings);
        } catch (batchError) {
          this.logger.error(
            `[KnowledgeBaseService] Batch ${Math.floor(i / 100) + 1} failed: ${batchError.message}`,
          );
          throw new Error(
            `Error generating embeddings for batch ${Math.floor(i / 100) + 1}: ${batchError.message}`,
          );
        }
      }

      const embeddings = allEmbeddings;
      this.logger.log(
        `[KnowledgeBaseService] Generated ${embeddings.length} embeddings in ${Math.ceil(chunkTexts.length / 100)} batches`,
      );

      this.logger.log(
        `[KnowledgeBaseService] Storing chunks in vector database...`,
      );
      // Store in vector database
      await this.vectorStoreService.storeChunks(sourceId, chunks, embeddings);
      this.logger.log(`[KnowledgeBaseService] Chunks stored successfully`);

      this.logger.log(
        `[KnowledgeBaseService] Updating source status to COMPLETED...`,
      );
      // Update source with processing results
      await this.firestore
        .collection('knowledgeSources')
        .doc(sourceId)
        .update({
          status: KnowledgeSourceStatus.COMPLETED,
          updatedAt: new Date(),
          metadata: {
            ...processedText.metadata,
            chunkCount: chunks.length,
          },
        });
      this.logger.log(
        `[KnowledgeBaseService] Source status updated to COMPLETED`,
      );

      // Clean up temporary file if it exists
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      this.logger.log(
        `Successfully processed source ${sourceId} with ${chunks.length} chunks`,
      );
    } catch (error) {
      await this.updateSourceStatus(sourceId, KnowledgeSourceStatus.FAILED);
      throw error;
    }
  }

  async getUserSources(userId: string): Promise<KnowledgeSourceDto[]> {
    try {
      const snapshot = await this.firestore
        .collection('knowledgeSources')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map((doc) =>
        this.mapToDto({ id: doc.id, ...doc.data() }),
      );
    } catch (error) {
      this.logger.error(`Error getting user sources: ${error.message}`);
      throw new BadRequestException(
        `Failed to get user sources: ${error.message}`,
      );
    }
  }

  async updateKnowledgeSource(
    sourceId: string,
    updateDto: UpdateKnowledgeSourceDto,
  ): Promise<KnowledgeSourceDto> {
    try {
      const sourceRef = this.firestore
        .collection('knowledgeSources')
        .doc(sourceId);
      const sourceDoc = await sourceRef.get();

      if (!sourceDoc.exists) {
        throw new NotFoundException('Knowledge source not found');
      }

      const updateData = {
        ...updateDto,
        updatedAt: new Date(),
      };

      await sourceRef.update(updateData);

      const updatedDoc = await sourceRef.get();
      return this.mapToDto({ id: updatedDoc.id, ...updatedDoc.data() });
    } catch (error) {
      this.logger.error(`Error updating knowledge source: ${error.message}`);
      throw new BadRequestException(
        `Failed to update knowledge source: ${error.message}`,
      );
    }
  }

  async deleteKnowledgeSource(sourceId: string): Promise<void> {
    try {
      // Delete from Firestore
      await this.firestore
        .collection('knowledgeSources')
        .doc(sourceId)
        .delete();

      // Delete from vector store
      await this.vectorStoreService.deleteSource(sourceId);

      this.logger.log(`Successfully deleted source ${sourceId}`);
    } catch (error) {
      this.logger.error(`Error deleting knowledge source: ${error.message}`);
      throw new BadRequestException(
        `Failed to delete knowledge source: ${error.message}`,
      );
    }
  }

  async searchKnowledge(searchDto: SearchKnowledgeDto): Promise<any> {
    try {
      // Generate embedding for query
      const queryEmbedding = await this.embeddingsService.generateEmbedding(
        searchDto.query,
      );

      // Search in vector store
      const results = await this.vectorStoreService.search(
        queryEmbedding,
        searchDto.sourceIds,
        searchDto.limit || 10,
      );

      // Get source names for results
      const sourceIds = [...new Set(results.map((r) => r.sourceId))];
      const sourceDocs = await this.firestore
        .collection('knowledgeSources')
        .where('id', 'in', sourceIds)
        .get();

      const sourceMap = new Map();
      sourceDocs.docs.forEach((doc) => {
        sourceMap.set(doc.id, doc.data().name);
      });

      return {
        query: searchDto.query,
        results: results.map((result) => ({
          sourceId: result.sourceId,
          sourceName: sourceMap.get(result.sourceId) || 'Unknown',
          chunkId: result.chunkId,
          content: result.content,
          score: result.score,
        })),
        totalResults: results.length,
      };
    } catch (error) {
      this.logger.error(`Error searching knowledge: ${error.message}`);
      throw new BadRequestException(
        `Failed to search knowledge: ${error.message}`,
      );
    }
  }

  async linkSourcesToAgent(
    agentId: number,
    userId: string,
    linkDto: LinkKnowledgeToAgentDto,
  ): Promise<void> {
    try {
      const batch = this.firestore.batch();

      for (const sourceId of linkDto.sourceIds) {
        const linkId = `link_${agentId}_${sourceId}_${Date.now()}`;
        const linkRef = this.firestore
          .collection('agentKnowledgeLinks')
          .doc(linkId);

        batch.set(linkRef, {
          id: linkId,
          agentId,
          knowledgeSourceId: sourceId,
          userId,
          addedAt: new Date(),
        });
      }

      await batch.commit();
      this.logger.log(
        `Successfully linked ${linkDto.sourceIds.length} sources to agent ${agentId}`,
      );
    } catch (error) {
      this.logger.error(`Error linking sources to agent: ${error.message}`);
      throw new BadRequestException(
        `Failed to link sources to agent: ${error.message}`,
      );
    }
  }

  async getAgentKnowledgeSources(agentId: number): Promise<any[]> {
    try {
      const snapshot = await this.firestore
        .collection('agentKnowledgeLinks')
        .where('agentId', '==', agentId)
        .get();

      const sourceIds = snapshot.docs.map(
        (doc) => doc.data().knowledgeSourceId,
      );

      if (sourceIds.length === 0) {
        return [];
      }

      const sourceDocs = await this.firestore
        .collection('knowledgeSources')
        .where('id', 'in', sourceIds)
        .get();

      return sourceDocs.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        addedAt: snapshot.docs
          .find((link) => link.data().knowledgeSourceId === doc.id)
          ?.data().addedAt,
      }));
    } catch (error) {
      this.logger.error(
        `Error getting agent knowledge sources: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to get agent knowledge sources: ${error.message}`,
      );
    }
  }

  private async updateSourceStatus(
    sourceId: string,
    status: KnowledgeSourceStatus,
  ): Promise<void> {
    try {
      await this.firestore.collection('knowledgeSources').doc(sourceId).update({
        status,
        updatedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(`Error updating source status: ${error.message}`);
    }
  }

  private mapToDto(sourceData: any): KnowledgeSourceDto {
    return {
      id: sourceData.id,
      userId: sourceData.userId,
      name: sourceData.name,
      type: sourceData.type,
      originalUrl: sourceData.originalUrl,
      fileName: sourceData.fileName,
      status: sourceData.status,
      createdAt: sourceData.createdAt?.toDate?.() || sourceData.createdAt,
      updatedAt: sourceData.updatedAt?.toDate?.() || sourceData.updatedAt,
      metadata: sourceData.metadata,
      tags: sourceData.tags || [],
      isPublic: sourceData.isPublic || false,
    };
  }
}
