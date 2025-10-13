import { ApiProperty } from '@nestjs/swagger';

export class UploadImageResponseDto {
  @ApiProperty({
    example: 'Imagen de perfil actualizada correctamente',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({
    example: 'https://storage.googleapis.com/bucket/profile-images/user123.jpg',
    description: 'URL pública de la imagen subida',
  })
  imageUrl: string;
}
