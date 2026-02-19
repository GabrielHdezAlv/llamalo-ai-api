import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { SetAgentConfigDto } from '../../agents/dto/set-agent-config.dto';
import { KnowledgeSourceType } from '../../knowledge-base/dto/knowledge-source.dto';

/**
 * Respuesta de GET /support-agent/config.
 * Misma forma que la configuración de un agente (SetAgentConfigDto)
 * más campos específicos del agente de soporte.
 */
export class SupportAgentConfigResponseDto extends SetAgentConfigDto {
  @ApiProperty({
    description: 'Si el agente de soporte (Xenon) está activo',
  })
  enabled: boolean;

  @ApiProperty({
    description: 'Última actualización de la configuración',
  })
  updatedAt: Date;
}

/**
 * Body para PUT /support-agent/config.
 * Mismo DTO que la edición de agente (SetAgentConfigDto);
 * el frontend envía la misma forma que al editar un agente,
 * más contactEmail y model si aplica.
 */
export type UpdateSupportAgentConfigDto = SetAgentConfigDto;

export class CreateSupportSourceDto {
  @ApiProperty({
    enum: KnowledgeSourceType,
    description: 'Tipo de fuente: pdf, web o text',
  })
  @IsEnum(KnowledgeSourceType)
  type: KnowledgeSourceType;

  @ApiProperty({
    description: 'Nombre descriptivo de la fuente',
    example: 'Documentación de LlamaloAI',
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: 'URL (solo para tipo web)',
    required: false,
    maxLength: 2048,
  })
  @IsOptional()
  @IsString()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'La URL debe ser válida y comenzar con http:// o https://' },
  )
  @MaxLength(2048)
  url?: string;

  @ApiProperty({
    description: 'Contenido de texto (solo para tipo text)',
    required: false,
    maxLength: 50000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  content?: string;
}
