import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsNumber } from 'class-validator';

export class TwilioConfigDto {
  @ApiProperty({
    example: 1,
    description:
      'ID de la cuenta de Twilio (opcional para crear nueva, requerido para actualizar)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  twilioAccountId?: number;

  @ApiProperty({
    example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description: 'Account SID de Twilio',
  })
  @IsNotEmpty()
  @IsString()
  twilioSid: string;

  @ApiProperty({
    example: 'your_twilio_auth_token',
    description: 'Auth Token de Twilio',
  })
  @IsNotEmpty()
  @IsString()
  twilioToken: string;
}
