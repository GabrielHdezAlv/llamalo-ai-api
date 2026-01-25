import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsObject,
  ValidateNested,
  IsInt,
  IsNumber,
  IsBoolean,
  IsOptional,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PhoneNumberDto {
  @ApiProperty({
    example: '+34',
    description: 'Código de país',
  })
  @IsNotEmpty()
  @IsString()
  countryCode: string;

  @ApiProperty({
    example: 654316415,
    description: 'Número de teléfono',
  })
  @IsNotEmpty()
  @IsInt()
  number: number;
}

export class AgentParametersDto {
  @ApiProperty({
    example: 0.5,
    description: 'Estabilidad de la voz (0.0 - 1.0)',
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(1)
  stability: number;

  @ApiProperty({
    example: 0.75,
    description: 'Similitud de la voz (0.0 - 1.0)',
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(1)
  similarity: number;

  @ApiProperty({
    example: 0.0,
    description: 'Estilo de la voz (0.0 - 1.0)',
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(1)
  style: number;

  @ApiProperty({
    example: false,
    description: 'Boost de la voz',
  })
  @IsNotEmpty()
  @IsBoolean()
  boost: boolean;

  @ApiProperty({
    example: 1.0,
    description: 'Velocidad de la voz (0.25 - 4.0)',
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0.25)
  @Max(4.0)
  speed: number;
}

export class SetAgentConfigDto {
  @ApiProperty({
    example: 'Marta',
    description: 'Nombre del agente',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    example: 'es',
    description: 'Código del idioma (solo siglas, ej: "es", "en", "fr")',
  })
  @IsNotEmpty()
  @IsString()
  language: string;

  @ApiProperty({
    example: 'inbound',
    description: 'Tipo de agente',
    enum: ['outbound', 'inbound'],
  })
  @IsNotEmpty()
  @IsEnum(['outbound', 'inbound'])
  type: 'outbound' | 'inbound';

  @ApiProperty({
    example: 'gD1IexrzCvsXPHUuT0s3',
    description: 'ID del modelo de voz en ElevenLabs',
  })
  @IsNotEmpty()
  @IsString()
  voiceId: string;

  @ApiProperty({
    example: 'Hola, bienvenido a LlamaloIA. ¿En qué puedo ayudarte?',
    description: 'Texto de la primera interacción',
  })
  @IsNotEmpty()
  @IsString()
  firstInteraction: string;

  @ApiProperty({
    example: 'Eres un asistente virtual amigable y profesional.',
    description: 'Instrucciones para el agente',
  })
  @IsNotEmpty()
  @IsString()
  agentInstruction: string;

  @ApiProperty({
    type: PhoneNumberDto,
    description: 'Número de teléfono asociado al agente',
  })
  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => PhoneNumberDto)
  phoneNumbers: PhoneNumberDto;

  @ApiProperty({
    example: 'Agente principal de atención al cliente',
    description: 'Etiqueta o descripción del agente',
  })
  @IsNotEmpty()
  @IsString()
  label: string;

  @ApiProperty({
    example: 'Activo',
    description: 'Estado del agente',
    enum: ['Activo', 'Inactivo'],
  })
  @IsNotEmpty()
  @IsEnum(['Activo', 'Inactivo'])
  state: 'Activo' | 'Inactivo';

  @ApiProperty({
    type: AgentParametersDto,
    description: 'Parámetros de configuración de la voz',
  })
  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => AgentParametersDto)
  parameters: AgentParametersDto;

  @ApiProperty({
    example: 0,
    description: 'Total de minutos consumidos por el agente',
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalMinutes?: number;
}
