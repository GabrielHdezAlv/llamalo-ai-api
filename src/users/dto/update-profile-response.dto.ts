import { ApiProperty } from '@nestjs/swagger';

export class UpdateProfileResponseDto {
  @ApiProperty({
    example: 'Perfil actualizado correctamente',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({ example: 'Juan', description: 'Nombre del usuario' })
  name?: string;

  @ApiProperty({ example: 'Pérez', description: 'Apellido del usuario' })
  lastname?: string;

  @ApiProperty({
    example: 'https://storage.googleapis.com/...',
    description: 'URL de la imagen de perfil',
  })
  profileImage?: string;

  @ApiProperty({
    example: 'Mi Empresa S.A.',
    description: 'Nombre de la empresa',
  })
  enterprise?: string;

  @ApiProperty({
    example: 'https://miempresa.com',
    description: 'Sitio web de la empresa',
  })
  enterpriseWeb?: string;

  @ApiProperty({
    example: 'juan.perez@gmail.com',
    description: 'Email del usuario',
  })
  email?: string;

  @ApiProperty({
    example: '2025-10-12T10:30:45.000Z',
    description: 'Fecha de creación',
  })
  createdAt?: string;
}
