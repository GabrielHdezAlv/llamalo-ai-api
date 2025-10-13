import { ApiProperty } from '@nestjs/swagger';

export class TwilioInfoResponseDto {
  @ApiProperty({
    example: '+34',
    description: 'Código de país',
  })
  countryCode?: string;

  @ApiProperty({
    example: 654316415,
    description: 'Número de teléfono',
  })
  phoneNumber?: number;

  @ApiProperty({
    example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description: 'Account SID de Twilio',
  })
  twilioSid?: string;

  @ApiProperty({
    example: 'your_twilio_auth_token',
    description: 'Auth Token de Twilio',
  })
  twilioToken?: string;

  @ApiProperty({
    example: 'Hola, bienvenido a LlamaloIA. ¿En qué puedo ayudarte?',
    description: 'Texto de la primera interacción',
  })
  firstInteraction?: string;

  @ApiProperty({
    example: 'your_url_to_the_audio',
    description: 'URL del audio de primera interacción',
  })
  firstInteractionUrl?: string;

  @ApiProperty({
    example: 'Eres un asistente virtual amigable y profesional.',
    description: 'Instrucciones para el agente',
  })
  agentInstruction?: string;
}
