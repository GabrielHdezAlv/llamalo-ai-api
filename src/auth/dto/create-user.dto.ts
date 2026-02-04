import {
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsBoolean,
  IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({
    example: 'Juan',
    description: 'Nombre del usuario',
  })
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'Pérez',
    description: 'Apellido del usuario',
  })
  @IsNotEmpty()
  lastname: string;

  @ApiProperty({
    example: 'juan.perez@gmail.com',
    description: 'Email del usuario',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'Juan12345$',
    description: 'Contraseña del usuario',
  })
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiProperty({
    example: 'ES',
    description: 'Código de país del usuario',
  })
  @IsNotEmpty()
  country: string;

  @ApiProperty({
    example: true,
    description: 'Consentimiento de marketing',
  })
  @IsBoolean()
  marketingConsent: boolean;

  @ApiProperty({
    example: 3,
    description:
      'Estado de la cuenta: 0 = Inactivo, 1 = Activo, 2 = Eliminado, 3 = No validado',
  })
  @IsNotEmpty()
  @IsIn([0, 1, 2, 3])
  accountStatus: number;
}
