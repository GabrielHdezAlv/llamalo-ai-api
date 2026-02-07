import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsOptional } from 'class-validator';

export class CreateAgentWithKnowledgeDto {
  @ApiProperty({
    description: 'Fuentes de conocimiento nuevas para este agente',
  })
  @IsOptional()
  @IsArray()
  newSources?: Array<{
    type: 'pdf' | 'web' | 'text';
    name: string;
    url?: string;
    content?: string;
    tags?: string[];
    isPublic?: boolean;
  }>;

  @ApiProperty({ description: 'IDs de fuentes existentes a vincular' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  existingSourceIds?: string[];
}

export class AgentKnowledgeResponseDto {
  @ApiProperty()
  agentId: number;

  @ApiProperty()
  knowledgeSources: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    addedAt: Date;
  }>;
}

export class KnowledgeSearchResponseDto {
  @ApiProperty()
  query: string;

  @ApiProperty()
  results: Array<{
    sourceId: string;
    sourceName: string;
    chunkId: string;
    content: string;
    score: number;
  }>;

  @ApiProperty()
  totalResults: number;
}
