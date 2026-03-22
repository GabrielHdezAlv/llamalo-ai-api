import { Injectable, Logger } from '@nestjs/common';
import { getFirestore } from '../../firebase/firebase.config';
import { TextChunk } from '../utils/chunker';
import { EmbeddingsService } from './embeddings.service';

export interface VectorSearchResult {
  chunkId: string;
  sourceId: string;
  content: string;
  score: number;
  metadata: any;
}

@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);
  private readonly firestore = getFirestore();
  private readonly vectorStore = new Map<string, TextChunk[]>();
  private readonly embeddings = new Map<string, number[][]>();

  constructor(private readonly embeddingsService: EmbeddingsService) {}

  async storeChunks(
    sourceId: string,
    chunks: TextChunk[],
    chunkEmbeddings: number[][],
  ): Promise<void> {
    try {
      // Store in memory for fast access
      this.vectorStore.set(sourceId, chunks);
      this.embeddings.set(sourceId, chunkEmbeddings);

      // Store in Firestore for persistence - process in batches
      // Firestore limit is 500 operations per batch. We use 450 to leave a safe margin.
      const batchSize = 450;
      const totalBatches = Math.ceil(chunks.length / batchSize);

      this.logger.log(
        `🔄 Storing ${chunks.length} chunks in ${totalBatches} batches...`,
      );

      const batchPromises: Promise<void>[] = [];

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, chunks.length);
        const batchChunks = chunks.slice(startIndex, endIndex);
        const batchEmbeddings = chunkEmbeddings.slice(startIndex, endIndex);

        const batch = this.firestore.batch();

        batchChunks.forEach((chunk, index) => {
          const chunkRef = this.firestore
            .collection('vectorChunks')
            .doc(`${sourceId}_${chunk.id}`);

          const chunkData = {
            sourceId,
            chunkId: chunk.id,
            content: chunk.content,
            embedding: batchEmbeddings[index],
            metadata: chunk.metadata,
            createdAt: new Date(),
          };

          batch.set(chunkRef, chunkData);
        });

        // Add the commit promise to the array
        const commitPromise = batch.commit().then(() => {
          this.logger.log(
            `✅ Batch ${batchIndex + 1}/${totalBatches} completed (${batchChunks.length} chunks)`,
          );
        });
        batchPromises.push(commitPromise);
      }

      // Wait for all batches to complete in parallel
      await Promise.all(batchPromises);

      this.logger.log(
        `✅ Successfully stored ${chunks.length} chunks for source ${sourceId} in Firestore`,
      );
    } catch (error) {
      this.logger.error(`Error storing chunks: ${error.message}`);
      throw new Error(`Failed to store chunks: ${error.message}`);
    }
  }

  async search(
    queryEmbedding: number[],
    sourceIds?: string[],
    limit: number = 10,
  ): Promise<VectorSearchResult[]> {
    try {
      const results: VectorSearchResult[] = [];

      // First try to load from Firestore if not in memory
      if (sourceIds) {
        for (const sourceId of sourceIds) {
          if (!this.vectorStore.has(sourceId)) {
            await this.loadSourceFromFirestore(sourceId);
          }
        }
      }

      // Determine which sources to search
      const sourcesToSearch = sourceIds || Array.from(this.vectorStore.keys());

      for (const sourceId of sourcesToSearch) {
        const chunks = this.vectorStore.get(sourceId);
        const embeddings = this.embeddings.get(sourceId);

        if (!chunks || !embeddings) {
          continue;
        }

        // Calculate similarity scores
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkEmbedding = embeddings[i];

          const similarity = this.calculateCosineSimilarity(
            queryEmbedding,
            chunkEmbedding,
          );

          results.push({
            chunkId: chunk.id,
            sourceId: chunk.metadata.sourceId,
            content: chunk.content,
            score: similarity,
            metadata: chunk.metadata,
          });
        }
      }

      // Sort by similarity score and return top results
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (error) {
      this.logger.error(`Error searching vectors: ${error.message}`);
      throw new Error(`Failed to search vectors: ${error.message}`);
    }
  }

  async deleteSource(sourceId: string): Promise<void> {
    try {
      // Delete from memory
      this.vectorStore.delete(sourceId);
      this.embeddings.delete(sourceId);

      // Delete from Firestore in batches (límite 500 ops por transacción)
      const snapshot = await this.firestore
        .collection('vectorChunks')
        .where('sourceId', '==', sourceId)
        .get();

      const docs = snapshot.docs;
      const BATCH_SIZE = 500;

      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = this.firestore.batch();
        const chunk = docs.slice(i, i + BATCH_SIZE);
        chunk.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }

      this.logger.log(
        `Deleted source ${sourceId} from vector store and Firestore (${docs.length} chunks)`,
      );
    } catch (error) {
      this.logger.error(`Error deleting source: ${error.message}`);
      throw new Error(`Failed to delete source: ${error.message}`);
    }
  }

  async loadSourceFromFirestore(sourceId: string): Promise<void> {
    try {
      const snapshot = await this.firestore
        .collection('vectorChunks')
        .where('sourceId', '==', sourceId)
        .get();

      if (snapshot.empty) {
        this.logger.warn(`No chunks found for source ${sourceId} in Firestore`);
        return;
      }

      const chunks: TextChunk[] = [];
      const embeddings: number[][] = [];

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        chunks.push({
          id: data.chunkId,
          content: data.content,
          metadata: data.metadata,
        });
        embeddings.push(data.embedding as number[]);
      });

      // Load into memory
      this.vectorStore.set(sourceId, chunks);
      this.embeddings.set(sourceId, embeddings);

      this.logger.log(
        `Loaded ${chunks.length} chunks for source ${sourceId} from Firestore`,
      );
    } catch (error) {
      this.logger.error(
        `Error loading source from Firestore: ${error.message}`,
      );
      throw new Error(`Failed to load source from Firestore: ${error.message}`);
    }
  }

  async getSourceChunks(sourceId: string): Promise<TextChunk[]> {
    // Try to load from Firestore if not in memory
    if (!this.vectorStore.has(sourceId)) {
      await this.loadSourceFromFirestore(sourceId);
    }

    return this.vectorStore.get(sourceId) || [];
  }

  private calculateCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }
}
