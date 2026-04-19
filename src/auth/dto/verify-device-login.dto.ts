import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength, Length } from 'class-validator';

export class VerifyDeviceLoginDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiProperty({ description: 'Identificador estable del navegador/dispositivo' })
  @IsNotEmpty()
  deviceId: string;

  @ApiProperty({ description: 'Código de 6 dígitos enviado al correo' })
  @Length(6, 6)
  code: string;
}
