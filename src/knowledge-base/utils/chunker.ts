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
    // Clean text and extract words
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    
    if (words.length === 0 || (words.length === 1 && words[0] === '')) {
      return chunks;
    }

    let chunkIndex = 0;
    
    // Step size is chunkSize minus overlap
    const step = Math.max(1, this.chunkSize - this.chunkOverlap);

    for (let i = 0; i < words.length; i += step) {
      // Get the block of words for the current chunk
      const chunkWords = words.slice(i, i + this.chunkSize);
      const currentChunk = chunkWords.join(' ').trim();
      
      if (currentChunk.length > 0) {
        // Approximate position finding
        // We use a search range to find the word position efficiently in large texts
        const searchRange = Math.max(0, (i / words.length) * text.length - 1000);
        const positionStart = text.indexOf(chunkWords[0], searchRange);
        
        chunks.push({
          id: `${sourceId}_chunk_${chunkIndex}`,
          content: currentChunk,
          metadata: {
            sourceId,
            chunkIndex,
            wordCount: chunkWords.length,
            position: {
              start: positionStart !== -1 ? positionStart : 0,
              end: positionStart !== -1 ? positionStart + currentChunk.length : currentChunk.length,
            },
          },
        });
        
        chunkIndex++;

        // If we've reached the end of the words, stop
        if (i + this.chunkSize >= words.length) {
          break;
        }
      }
    }

    return chunks;
  }
}
