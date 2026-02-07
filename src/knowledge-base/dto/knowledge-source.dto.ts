import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsArray, IsBoolean } from 'class-validator';

export enum KnowledgeSourceType {
  PDF = 'pdf',
  WEB = 'web',
  TEXT = 'text',
}

export enum KnowledgeSourceStatus {
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export class CreateKnowledgeSourceDto {
  @ApiProperty({ enum: KnowledgeSourceType, description: 'Tipo de fuente de conocimiento' })
  @IsEnum(KnowledgeSourceType)
  type: KnowledgeSourceType;

  @ApiProperty({ description: 'Nombre descriptivo de la fuente' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'URL para fuentes tipo web', required: false })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiProperty({ description: 'Contenido de texto para fuentes tipo text', required: false })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({ description: 'Etiquetas para categorizar la fuente', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ description: 'Si la fuente es pública y puede ser reutilizada', required: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateKnowledgeSourceDto {
  @ApiProperty({ description: 'Nombre descriptivo de la fuente', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Etiquetas para categorizar la fuente', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ description: 'Si la fuente es pública y puede ser reutilizada', required: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class KnowledgeSourceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: KnowledgeSourceType })
  type: KnowledgeSourceType;

  @ApiProperty({ required: false })
  originalUrl?: string;

  @ApiProperty({ required: false })
  fileName?: string;

  @ApiProperty({ enum: KnowledgeSourceStatus })
  status: KnowledgeSourceStatus;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  metadata: {
    size?: number;
    pageCount?: number;
    wordCount?: number;
    chunkCount: number;
  };

  @ApiProperty()
  tags: string[];

  @ApiProperty()
  isPublic: boolean;
}

export class SearchKnowledgeDto {
  @ApiProperty({ description: 'Consulta de búsqueda' })
  @IsString()
  query: string;

  @ApiProperty({ description: 'IDs de fuentes para filtrar', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceIds?: string[];

  @ApiProperty({ description: 'Límite de resultados', required: false })
  @IsOptional()
  limit?: number;
}

export class SearchResultDto {
  @ApiProperty()
  sourceId: string;

  @ApiProperty()
  sourceName: string;

  @ApiProperty()
  chunkId: string;

  @ApiProperty()
  content: string;

  @ApiProperty()
  score: number;
}

export class LinkKnowledgeToAgentDto {
  @ApiProperty({ description: 'IDs de fuentes de conocimiento a vincular' })
  @IsArray()
  @IsString({ each: true })
  sourceIds: string[];
}

export class AgentKnowledgeLinkDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  agentId: number;

  @ApiProperty()
  knowledgeSourceId: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  addedAt: Date;
}
