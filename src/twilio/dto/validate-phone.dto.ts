import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsNumber } from 'class-validator';

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

  @ApiProperty({
    example: 1,
    description: 'ID de la cuenta de Twilio a usar (opcional, usa la primera cuenta si no se especifica)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  twilioAccountId?: number;
}
