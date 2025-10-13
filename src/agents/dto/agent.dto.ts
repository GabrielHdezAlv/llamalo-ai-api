import { ApiProperty } from '@nestjs/swagger';
import { LanguageConfigDto } from './language-config.dto';

export class AgentDto {
  @ApiProperty({
    example: 'Ana García',
    description: 'Nombre del agente',
  })
  name: string;

  @ApiProperty({
    example: 'pNInz6obpgDQGcFmaJgB',
    description: 'ID del modelo de voz en ElevenLabs',
  })
  labsId: string;

  @ApiProperty({
    example: 'https://example.com/photo.jpg',
    description: 'URL de la foto del agente',
  })
  photoUrl?: string;

  @ApiProperty({
    type: LanguageConfigDto,
    description: 'Configuración del idioma del agente',
  })
  language?: LanguageConfigDto;
}
