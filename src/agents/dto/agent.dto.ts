import { ApiProperty } from '@nestjs/swagger';
import { LanguageConfigDto } from './language-config.dto';

export class AgentDto {
  @ApiProperty({
    example: 'Ana García',
    description: 'Nombre de la voz',
  })
  name: string;

  @ApiProperty({
    example: 'pNInz6obpgDQGcFmaJgB',
    description: 'ID del modelo de voz en ElevenLabs',
  })
  voiceId: string;
}
