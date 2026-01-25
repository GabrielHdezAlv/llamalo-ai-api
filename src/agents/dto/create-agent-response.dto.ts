import { ApiProperty } from '@nestjs/swagger';

export class AgentDto {
  @ApiProperty({ example: 'Marta', description: 'Nombre del agente' })
  name: string;

  @ApiProperty({
    example: 'inbound',
    description: 'Tipo de agente',
    enum: ['outbound', 'inbound'],
  })
  type: 'outbound' | 'inbound';

  @ApiProperty({ example: 'es', description: 'Código del idioma' })
  language: string;

  @ApiProperty({
    example: 'gD1IexrzCvsXPHUuT0s3',
    description: 'ID de voz ElevenLabs',
  })
  voiceId: string;

  @ApiProperty({
    example: 'Hola, bienvenido...',
    description: 'Primera interacción',
  })
  firstInteraction: string;

  @ApiProperty({
    example: 'Eres un asistente...',
    description: 'Instrucciones del agente',
  })
  agentInstruction: string;

  @ApiProperty({
    description: 'Número de teléfono asociado',
  })
  phoneNumbers: {
    phoneId: number;
    countryCode: string;
    number: string;
  };

  @ApiProperty({
    example: 'Agente principal',
    description: 'Etiqueta del agente',
  })
  label: string;
}

export class CreateAgentResponseDto {
  @ApiProperty({
    example: 'Agente creado correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({ type: AgentDto, description: 'Agente creado' })
  agent: AgentDto;

  @ApiProperty({
    example: 0,
    description: 'Índice del agente en el array',
  })
  index: number;
}
