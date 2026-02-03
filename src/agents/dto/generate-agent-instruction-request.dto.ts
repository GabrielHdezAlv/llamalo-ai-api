import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AgentParametersDto } from './set-agent-config.dto';

export class GenerateAgentInstructionRequestDto {
  @ApiProperty({
    example: 'Mi Empresa S.A.',
    description: 'Nombre de la empresa',
  })
  @IsNotEmpty()
  @IsString()
  enterpriseName: string;

  @ApiProperty({
    example: 'Tony',
    description: 'Nombre del agente',
  })
  @IsNotEmpty()
  @IsString()
  agentName: string;

  @ApiProperty({
    example: 'inbound',
    description: 'Tipo de llamada (inbound/outbound)',
    enum: ['outbound', 'inbound'],
  })
  @IsNotEmpty()
  @IsEnum(['outbound', 'inbound'])
  callType: 'outbound' | 'inbound';

  @ApiProperty({
    example: 'es',
    description: 'Idioma ISO-639-1 (ej: es, en, fr)',
  })
  @IsNotEmpty()
  @IsString()
  language: string;

  @ApiProperty({
    example: 'gD1IexrzCvsXPHUuT0s3',
    description: 'ID de la voz seleccionada',
  })
  @IsNotEmpty()
  @IsString()
  voiceId: string;

  @ApiProperty({
    type: AgentParametersDto,
    description: 'Parámetros de la voz seleccionada',
  })
  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => AgentParametersDto)
  voiceParameters: AgentParametersDto;

  @ApiProperty({
    example: 'mi-tienda.myshopify.com',
    description: 'Shop domain (opcional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  shopDomain?: string;

  @ApiProperty({
    example: 'Quiero un agente de soporte que sea cercano y proactivo...',
    description:
      'Texto libre del usuario: describe qué tipo de agente quiere y su comportamiento',
  })
  @IsNotEmpty()
  @IsString()
  userDescription: string;
}
