import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ValidatePhoneDto {
  @ApiProperty({
    example: '+34654316415',
    description: 'Número de teléfono a validar (formato E.164)',
  })
  @IsNotEmpty()
  @IsString()
  phoneNumber: string;
}

