import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateAgentWithKnowledgeDto {
  @ApiProperty({
    description: 'Fuentes de conocimiento nuevas para este agente',
    type: [Object],
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

  @ApiProperty({
    description: 'IDs de fuentes existentes a vincular',
    type: 'array',
    items: { type: 'string' },
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  existingSourceIds?: string[];
}
