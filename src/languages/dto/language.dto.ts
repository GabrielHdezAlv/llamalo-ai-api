import { ApiProperty } from '@nestjs/swagger';

export class LanguageDto {
  @ApiProperty({
    example: 'es',
    description: 'Código del idioma (ISO 639-1)',
  })
  id: string;

  @ApiProperty({
    example: 'Español',
    description: 'Nombre del idioma',
  })
  name: string;

  @ApiProperty({
    example: 'es-ES',
    description: 'Código de localización completo',
  })
  code?: string;

  @ApiProperty({
    example: true,
    description: 'Indica si el idioma está activo',
  })
  active?: boolean;
}
