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
  labsId: string;

  @ApiProperty({
    example: 'Marta',
    description: 'Nombre del agente',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    example:
      'https://firebasestorage.googleapis.com/v0/b/llamaloio.firebasestorage.app/o/agent_04.png?alt=media&token=76741bb5-1035-4a36-970b-cae7af407099',
    description: 'URL de la foto del agente',
  })
  @IsNotEmpty()
  @IsString()
  photoUrl: string;

  @ApiProperty({
    type: LanguageConfigDto,
    description: 'Configuración del idioma del agente',
  })
  @ValidateNested()
  @Type(() => LanguageConfigDto)
  language: LanguageConfigDto;
}
