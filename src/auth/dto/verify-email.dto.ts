import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({
    example: 'abc123def456ghi789',
    description: 'Token de verificación de email',
  })
  @IsNotEmpty()
  @IsString()
  token: string;
}
