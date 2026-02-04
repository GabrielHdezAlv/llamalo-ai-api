import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsEmail } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({
    example: 'usuario@example.com',
    description: 'Email del usuario que quiere reenviar la verificación',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;
}
