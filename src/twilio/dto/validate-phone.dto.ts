import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ValidatePhoneDto {
  @ApiProperty({
    example: '+34',
    description: 'Prefijo del país (formato E.164, ej: +34, +1, +44)',
  })
  @IsNotEmpty()
  @IsString()
  countryCode: string;

  @ApiProperty({
    example: '654316415',
    description: 'Número de teléfono sin el prefijo del país',
  })
  @IsNotEmpty()
  @IsString()
  number: string;
}
