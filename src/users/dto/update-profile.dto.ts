import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({
    example: 'Juan',
    description: 'Nombre del usuario',
    required: false,
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    example: 'Pérez',
    description: 'Apellido del usuario',
    required: false,
  })
  @IsOptional()
  @IsString()
  lastname?: string;

  @ApiProperty({
    example: 'https://example.com/image.jpg',
    description: 'URL de la imagen de perfil',
    required: false,
  })
  @IsOptional()
  @IsString()
  profileImage?: string;

  @ApiProperty({
    example: 'Mi Empresa S.A.',
    description: 'Nombre de la empresa (se actualizará en enterprise.name)',
    required: false,
  })
  @IsOptional()
  @IsString()
  enterprise?: string;

  @ApiProperty({
    example: 'https://miempresa.com',
    description: 'Sitio web de la empresa (se actualizará en enterprise.url)',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  enterpriseWeb?: string;
}
