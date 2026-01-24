import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { LanguageConfigDto } from './language-config.dto';

export class SetAgentConfigDto {
  @ApiProperty({
    example: 'gD1IexrzCvsXPHUuT0s3',
    description: 'ID del modelo de voz en ElevenLabs',
  })
  @IsNotEmpty()
  @IsString()
  voiceId: string;

  @ApiProperty({
    example: 'Marta',
    description: 'Nombre del agente',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    type: LanguageConfigDto,
    description: 'Configuración del idioma del agente',
  })
  @ValidateNested()
  @Type(() => LanguageConfigDto)
  language: LanguageConfigDto;
}
