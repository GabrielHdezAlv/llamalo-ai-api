import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  MaxLength,
  IsUrl,
  Min,
  Max,
} from 'class-validator';
import { KnowledgeSourceType } from '../../knowledge-base/dto/knowledge-source.dto';

export class UpdateSupportAgentConfigDto {
  @ApiProperty({
    description: 'System prompt / instrucciones del agente de soporte',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  instructions?: string;

  @ApiProperty({
    description: 'Nombre visible del agente',
    required: false,
    example: 'Asistente LlamaloAI',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: 'Mensaje de bienvenida al iniciar la conversación por voz',
    required: false,
    example: '¡Hola! Soy el asistente de LlamaloAI. ¿En qué puedo ayudarte?',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  greeting?: string;

  @ApiProperty({
    description: 'Idioma del agente de voz (es, en, etc.)',
    required: false,
    example: 'es',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiProperty({
    description: 'ID de voz de ElevenLabs para el agente de soporte',
    required: false,
    example: '15bJsujCI3tcDWeoZsQP',
  })
  @IsOptional()
  @IsString()
  voiceId?: string;

  @ApiProperty({
    description: 'Parámetros de voz ElevenLabs (stability, similarity, etc.)',
    required: false,
  })
  @IsOptional()
  voiceParameters?: {
    stability?: number;
    similarity?: number;
    style?: number;
    boost?: boolean;
    speed?: number;
  };

  @ApiProperty({
    description: 'Modelo de OpenAI a utilizar',
    required: false,
    example: 'gpt-4o-mini',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiProperty({
    description: 'Temperatura del LLM (0-2)',
    required: false,
    example: 0.7,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiProperty({
    description: 'Máximo de tokens en la respuesta',
    required: false,
    example: 500,
  })
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(4000)
  maxTokens?: number;

  @ApiProperty({
    description: 'Email de contacto para derivar a soporte humano',
    required: false,
    example: 'soporte@llamalo.ai',
  })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiProperty({
    description: 'WhatsApp de contacto para derivar a soporte humano',
    required: false,
  })
  @IsOptional()
  @IsString()
  contactWhatsapp?: string;

  @ApiProperty({
    description: 'Activar o desactivar el chat de soporte',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SupportAgentConfigDto {
  @ApiProperty() instructions: string;
  @ApiProperty() name: string;
  @ApiProperty() greeting: string;
  @ApiProperty() model: string;
  @ApiProperty() temperature: number;
  @ApiProperty() maxTokens: number;
  @ApiProperty({ required: false }) language?: string;
  @ApiProperty({ required: false }) voiceId?: string;
  @ApiProperty({ required: false }) voiceParameters?: {
    stability?: number;
    similarity?: number;
    style?: number;
    boost?: boolean;
    speed?: number;
  };
  @ApiProperty({ required: false }) contactEmail?: string;
  @ApiProperty({ required: false }) contactWhatsapp?: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty() updatedAt: Date;
}

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
