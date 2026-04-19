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
    example: { name: 'Mi Empresa S.A.', url: 'https://miempresa.com' },
    description: 'Información de la empresa',
  })
  enterprise?: {
    name: string;
    url: string;
  };

  @ApiProperty({
    example: 'juan.perez@gmail.com',
    description: 'Email del usuario',
  })
  email?: string;

  @ApiProperty({
    example: 'ES',
    description: 'Código de país del usuario',
  })
  country?: string;

  @ApiProperty({
    example: true,
    description: 'Consentimiento de marketing',
  })
  marketingConsent?: boolean;

  @ApiProperty({
    example: 1,
    description: 'Estado de la cuenta: 0 = Inactivo, 1 = Activo, 2 = Eliminado',
  })
  accountStatus?: number;

  @ApiProperty({
    example: '2025-10-12T10:30:45.000Z',
    description: 'Fecha de creación',
  })
  createdAt?: string;

  @ApiProperty({
    example: 'Europe/Madrid',
    description:
      'Zona horaria IANA usada para períodos de métricas en el panel',
    required: false,
  })
  metricsCalendarTimezone?: string;
}
