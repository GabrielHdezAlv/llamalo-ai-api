import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'test@llamalo.com',
    description: 'Email del usuario',
    default: 'test@llamalo.com',
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
