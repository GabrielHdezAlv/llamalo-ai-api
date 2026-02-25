export interface TextChunk {
  id: string;
  content: string;
  metadata: {
    sourceId: string;
    chunkIndex: number;
    wordCount: number;
    position: {
      start: number;
      end: number;
    };
  };
}

export class TextChunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(chunkSize = 1000, chunkOverlap = 200) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  createChunks(text: string, sourceId: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const words = text.split(/\s+/);
    let currentChunk = '';
    let chunkIndex = 0;
    let positionStart = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testChunk = currentChunk ? `${currentChunk} ${word}` : word;

      if (testChunk.length > this.chunkSize && currentChunk) {
        // Save current chunk
        chunks.push({
          id: `${sourceId}_chunk_${chunkIndex}`,
          content: currentChunk.trim(),
          metadata: {
            sourceId,
            chunkIndex,
            wordCount: currentChunk.split(/\s+/).length,
            position: {
              start: positionStart,
              end: positionStart + currentChunk.length,
            },
          },
        });

        // Start new chunk with overlap
        const overlapWords = currentChunk
          .split(/\s+/)
          .slice(-Math.floor(this.chunkOverlap / 10));
        currentChunk = overlapWords.join(' ');
        positionStart = text.indexOf(currentChunk, positionStart);
        chunkIndex++;
      }

      currentChunk = testChunk;
    }

    // Add last chunk if it has content
    if (currentChunk.trim()) {
      chunks.push({
        id: `${sourceId}_chunk_${chunkIndex}`,
        content: currentChunk.trim(),
        metadata: {
          sourceId,
          chunkIndex,
          wordCount: currentChunk.split(/\s+/).length,
          position: {
            start: positionStart,
            end: text.length,
          },
        },
      });
    }

    return chunks;
  }
}
