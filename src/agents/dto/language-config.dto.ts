import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LanguageConfigDto {
  @ApiProperty({
    example: 'https://flagcdn.com/w40/es.png',
    description: 'Bandera del idioma',
  })
  @IsNotEmpty()
  @IsString()
  flag: string;

  @ApiProperty({
    example: 'España',
    description: 'Nombre del idioma',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    example: 'es',
    description: 'Código del idioma',
  })
  @IsNotEmpty()
  @IsString()
  code: string;
}
