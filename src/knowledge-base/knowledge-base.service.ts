import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';
import { FieldPath } from 'firebase-admin/firestore';
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

      const knowledgeSource: Record<string, unknown> = {
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

      if (
        createSourceDto.type === KnowledgeSourceType.TEXT &&
        createSourceDto.content
      ) {
        knowledgeSource.storedTextContent = createSourceDto.content;
      }

      // Create initial record in Firestore
      await this.firestore
        .collection('knowledgeSources')
        .doc(sourceId)
        .set(knowledgeSource);

      // Start async processing
      void this.processKnowledgeSource(
        sourceId,
        userId,
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
    userId: string,
    createSourceDto: CreateKnowledgeSourceDto,
    filePath?: string,
  ): Promise<void> {
    let pdfStoragePath: string | undefined;
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;

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
          if (bucketName) {
            try {
              const bucket = admin.storage().bucket(bucketName);
              pdfStoragePath = `knowledge-sources/${userId}/${sourceId}.pdf`;
              await bucket.upload(filePath, {
                destination: pdfStoragePath,
                metadata: {
                  contentType: 'application/pdf',
                },
              });
              await this.firestore
                .collection('knowledgeSources')
                .doc(sourceId)
                .update({
                  storagePath: pdfStoragePath,
                  updatedAt: new Date(),
                });
              this.logger.log(
                `[KnowledgeBaseService] PDF stored for download: ${pdfStoragePath}`,
              );
            } catch (uploadErr) {
              this.logger.warn(
                `PDF upload to Storage failed (download will be unavailable): ${(uploadErr as Error).message}`,
              );
            }
          } else {
            this.logger.warn(
              'FIREBASE_STORAGE_BUCKET not set; PDF originals will not be downloadable',
            );
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

      // Process embeddings in batches with dynamic sizing based on tokens
      const allEmbeddings: number[][] = [];
      const maxTokensPerBatch = 250000; // Stay under 300K limit with margin
      let totalTokensUsed = 0;

      let i = 0;
      let batchIndex = 0;
      while (i < chunkTexts.length) {
        let batchTokens = 0;
        let batchSize = 0;

        // Calculate optimal batch size based on token estimation
        while (
          i + batchSize < chunkTexts.length &&
          batchTokens < maxTokensPerBatch
        ) {
          const estimatedTokens = Math.ceil(
            chunkTexts[i + batchSize].length / 4,
          );
          if (batchTokens + estimatedTokens > maxTokensPerBatch) break;
          batchTokens += estimatedTokens;
          batchSize++;
        }

        totalTokensUsed += batchTokens;
        const batch = chunkTexts.slice(i, i + batchSize);
        this.logger.log(
          `[KnowledgeBaseService] Processing batch ${batchIndex + 1}/${Math.ceil(chunkTexts.length / 100)} (${batch.length} chunks, ~${batchTokens} tokens)`,
        );

        try {
          const batchEmbeddings =
            await this.embeddingsService.generateBatchEmbeddings(batch);
          allEmbeddings.push(...batchEmbeddings);
        } catch (batchError) {
          this.logger.error(
            `[KnowledgeBaseService] Batch ${batchIndex + 1} failed: ${batchError.message}`,
          );
          throw new Error(
            `Error generating embeddings for batch ${batchIndex + 1}: ${batchError.message}`,
          );
        }

        i += batchSize;
        batchIndex++;
      }

      const embeddings = allEmbeddings;
      this.logger.log(
        `[KnowledgeBaseService] Generated ${embeddings.length} embeddings in ${batchIndex} batches`,
      );
      this.logger.log(
        `[KnowledgeBaseService] Total tokens used: ${totalTokensUsed.toLocaleString()}`,
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
      if (pdfStoragePath && bucketName) {
        await admin
          .storage()
          .bucket(bucketName)
          .file(pdfStoragePath)
          .delete({ ignoreNotFound: true })
          .catch(() => undefined);
      }
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
      const docRef = this.firestore
        .collection('knowledgeSources')
        .doc(sourceId);
      const snap = await docRef.get();
      const data = snap.data() as { storagePath?: string } | undefined;
      const storagePath = data?.storagePath;

      if (storagePath && process.env.FIREBASE_STORAGE_BUCKET) {
        await admin
          .storage()
          .bucket(process.env.FIREBASE_STORAGE_BUCKET)
          .file(storagePath)
          .delete({ ignoreNotFound: true })
          .catch((err) =>
            this.logger.warn(`Storage delete skipped: ${err.message}`),
          );
      }

      await docRef.delete();

      await this.vectorStoreService.deleteSource(sourceId);

      this.logger.log(`Successfully deleted source ${sourceId}`);
    } catch (error) {
      this.logger.error(`Error deleting knowledge source: ${error.message}`);
      throw new BadRequestException(
        `Failed to delete knowledge source: ${error.message}`,
      );
    }
  }

  /**
   * Descarga: PDF desde Storage o texto plano desde Firestore (solo owner).
   */
  async getDownloadPayload(
    userId: string,
    sourceId: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const docRef = this.firestore.collection('knowledgeSources').doc(sourceId);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new NotFoundException('Fuente de conocimiento no encontrada');
    }
    const data = snap.data() as {
      userId: string;
      type: string;
      name?: string;
      fileName?: string;
      storagePath?: string;
      storedTextContent?: string;
    };

    if (data.userId !== userId) {
      throw new ForbiddenException('No autorizado');
    }

    if (data.type === KnowledgeSourceType.PDF && data.storagePath) {
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        throw new BadRequestException('Almacenamiento no configurado');
      }
      const [buffer] = await admin
        .storage()
        .bucket(bucketName)
        .file(data.storagePath)
        .download();
      const safeName = this.sanitizeDownloadFileName(
        data.fileName || `${sourceId}.pdf`,
      );
      const filename = safeName.toLowerCase().endsWith('.pdf')
        ? safeName
        : `${safeName}.pdf`;
      return {
        buffer,
        filename,
        mimeType: 'application/pdf',
      };
    }

    if (data.type === KnowledgeSourceType.TEXT && data.storedTextContent) {
      const base = this.sanitizeDownloadFileName(data.name || 'texto');
      const filename = base.toLowerCase().endsWith('.txt')
        ? base
        : `${base}.txt`;
      return {
        buffer: Buffer.from(data.storedTextContent, 'utf8'),
        filename,
        mimeType: 'text/plain; charset=utf-8',
      };
    }

    throw new BadRequestException(
      'Esta fuente no tiene un archivo descargable (solo PDF y texto con datos guardados)',
    );
  }

  private sanitizeDownloadFileName(name: string): string {
    const cleaned = (name || 'documento').replace(/[/\\?%*:|"<>]/g, '-').trim();
    return cleaned.slice(0, 180) || 'documento';
  }

  async searchKnowledge(searchDto: SearchKnowledgeDto): Promise<any> {
    try {
      const queryEmbedding = await this.embeddingsService.generateEmbedding(
        searchDto.query,
      );

      const results = await this.vectorStoreService.search(
        queryEmbedding,
        searchDto.sourceIds,
        searchDto.limit || 10,
      );

      const sourceIds = [...new Set(results.map((r) => r.sourceId))];

      if (sourceIds.length === 0) {
        return { results: [] };
      }

      const sourceDocs = await this.firestore
        .collection('knowledgeSources')
        .where(FieldPath.documentId(), 'in', sourceIds)
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

  async unlinkSourceFromAgent(
    agentId: number,
    sourceId: string,
    userId: string,
  ): Promise<void> {
    try {
      // Find the link document
      const snapshot = await this.firestore
        .collection('agentKnowledgeLinks')
        .where('agentId', '==', agentId)
        .where('knowledgeSourceId', '==', sourceId)
        .where('userId', '==', userId)
        .get();

      if (snapshot.empty) {
        throw new NotFoundException(
          `Link between agent ${agentId} and source ${sourceId} not found`,
        );
      }

      // Delete the link document
      const batch = this.firestore.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      this.logger.log(
        `Successfully unlinked source ${sourceId} from agent ${agentId}`,
      );
    } catch (error) {
      this.logger.error(`Error unlinking source from agent: ${error.message}`);
      throw new BadRequestException(
        `Failed to unlink source from agent: ${error.message}`,
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
        .where(FieldPath.documentId(), 'in', sourceIds)
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
    const type = sourceData.type as KnowledgeSourceType;
    const hasDownloadableContent =
      (type === KnowledgeSourceType.PDF && !!sourceData.storagePath) ||
      (type === KnowledgeSourceType.TEXT && !!sourceData.storedTextContent);

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
      hasDownloadableContent,
    };
  }
}
