import { Injectable, Logger } from '@nestjs/common';
import { TextChunk } from '../utils/chunker';

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
  private readonly vectorStore = new Map<string, TextChunk[]>();
  private readonly embeddings = new Map<string, number[][]>();

  async storeChunks(sourceId: string, chunks: TextChunk[], chunkEmbeddings: number[][]): Promise<void> {
    try {
      // Store chunks
      this.vectorStore.set(sourceId, chunks);
      
      // Store embeddings
      this.embeddings.set(sourceId, chunkEmbeddings);
      
      this.logger.log(`Stored ${chunks.length} chunks for source ${sourceId}`);
    } catch (error) {
      this.logger.error(`Error storing chunks: ${error.message}`);
      throw new Error(`Failed to store chunks: ${error.message}`);
    }
  }

  async search(
    queryEmbedding: number[],
    sourceIds?: string[],
    limit: number = 10
  ): Promise<VectorSearchResult[]> {
    try {
      const results: VectorSearchResult[] = [];
      
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
          
          const similarity = this.calculateCosineSimilarity(queryEmbedding, chunkEmbedding);
          
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
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      this.logger.error(`Error searching vectors: ${error.message}`);
      throw new Error(`Failed to search vectors: ${error.message}`);
    }
  }

  async deleteSource(sourceId: string): Promise<void> {
    try {
      this.vectorStore.delete(sourceId);
      this.embeddings.delete(sourceId);
      
      this.logger.log(`Deleted source ${sourceId} from vector store`);
    } catch (error) {
      this.logger.error(`Error deleting source: ${error.message}`);
      throw new Error(`Failed to delete source: ${error.message}`);
    }
  }

  async getSourceChunks(sourceId: string): Promise<TextChunk[]> {
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
