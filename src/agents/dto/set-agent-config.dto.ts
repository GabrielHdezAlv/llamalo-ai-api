import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsObject,
  ValidateNested,
  IsInt,
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
}
