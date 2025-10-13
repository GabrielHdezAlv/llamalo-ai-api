import { ApiProperty } from '@nestjs/swagger';

export class UserProfileResponseDto {
  @ApiProperty({ example: 'abc123', description: 'ID del usuario' })
  userId: string;

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
    example: '12 de octubre de 2025, 10:30:45',
    description: 'Fecha de creación formateada en español',
  })
  createdAt?: string | null;

  @ApiProperty({ description: 'Configuración de Twilio' })
  twilio?: Record<string, unknown>;

  @ApiProperty({ description: 'Configuración del agente' })
  agent?: Record<string, unknown>;
}
