import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsBoolean, IsIn } from 'class-validator';

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
    example: { name: 'Mi Empresa S.A.', url: 'https://miempresa.com' },
    description: 'Información de la empresa',
    required: false,
  })
  @IsOptional()
  enterprise?: {
    name: string;
    url: string;
  };

  @ApiProperty({
    example: 'ES',
    description: 'Código de país del usuario',
    required: false,
  })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({
    example: true,
    description: 'Consentimiento de marketing',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;

  @ApiProperty({
    example: 1,
    description:
      'Estado de la cuenta: 0 = Inactivo, 1 = Activo, 2 = Eliminado, 3 = No validado',
    required: false,
  })
  @IsOptional()
  @IsIn([0, 1, 2, 3])
  accountStatus?: number;

  @ApiProperty({
    example: 'client_user',
    description: 'Rol del usuario: owner o client_user',
    required: false,
  })
  @IsOptional()
  @IsIn(['owner', 'client_user'])
  rol?: 'owner' | 'client_user';
}
