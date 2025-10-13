import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsNumber } from 'class-validator';

export class TwilioConfigDto {
  @ApiProperty({
    example: '+34',
    description: 'Código de país del número de Twilio',
  })
  @IsNotEmpty()
  @IsString()
  countryCode: string;

  @ApiProperty({
    example: 654316415,
    description: 'Número de teléfono de Twilio',
  })
  @IsNotEmpty()
  @IsNumber()
  phoneNumber: number;

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

  @ApiProperty({
    example: 'Hola, bienvenido a LlamaloIA. ¿En qué puedo ayudarte?',
    description: 'Texto de la primera interacción',
  })
  @IsNotEmpty()
  @IsString()
  firstInteraction: string;

  @ApiProperty({
    example: 'your_url_to_the_audio',
    description: 'URL del audio de primera interacción',
  })
  @IsNotEmpty()
  @IsString()
  firstInteractionUrl: string;

  @ApiProperty({
    example: 'Eres un asistente virtual amigable y profesional.',
    description: 'Instrucciones para el agente',
  })
  @IsNotEmpty()
  @IsString()
  agentInstruction: string;
}
