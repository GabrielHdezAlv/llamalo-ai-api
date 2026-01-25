import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'development.team@llamalo.com',
    description: 'Email del usuario',
    default: 'development.team@llamalo.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'Test123$',
    description: 'Contraseña del usuario',
    default: 'Test123$',
  })
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}
