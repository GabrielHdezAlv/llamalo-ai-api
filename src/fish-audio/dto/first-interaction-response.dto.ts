import { ApiProperty } from '@nestjs/swagger';

export class FirstInteractionResponseDto {
  @ApiProperty({
    example: 'Audio generado y URL guardada exitosamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({
    example: 'https://storage.googleapis.com/bucket/audios/userId/audioId.mp3',
    description: 'URL pública del audio generado',
    required: false,
  })
  audioUrl?: string;
}
