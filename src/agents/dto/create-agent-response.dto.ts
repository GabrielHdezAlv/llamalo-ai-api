import { ApiProperty } from '@nestjs/swagger';

export class AgentParametersDto {
  @ApiProperty({ example: 0.5, description: 'Estabilidad de la voz' })
  stability: number;

  @ApiProperty({ example: 0.75, description: 'Similitud de la voz' })
  similarity: number;

  @ApiProperty({ example: 0.0, description: 'Estilo de la voz' })
  style: number;

  @ApiProperty({ example: false, description: 'Boost de la voz' })
  boost: boolean;

  @ApiProperty({ example: 1.0, description: 'Velocidad de la voz' })
  speed: number;
}

export class AgentDto {
  @ApiProperty({
    example: 1738000000000,
    description: 'ID único del agente',
  })
  agentId: number;

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
    example: 1738000000000,
    description: 'ID de la cuenta Twilio asignada al agente',
    required: false,
  })
  twilioAccountId?: number;

  @ApiProperty({
    example: 'Agente principal',
    description: 'Etiqueta del agente',
  })
  label: string;

  @ApiProperty({
    example: 'Activo',
    description: 'Estado del agente',
    enum: ['Activo', 'Inactivo'],
  })
  state: 'Activo' | 'Inactivo';

  @ApiProperty({
    type: AgentParametersDto,
    description: 'Parámetros de configuración de la voz',
  })
  parameters: AgentParametersDto;

  @ApiProperty({
    example: 0,
    description: 'Total de minutos consumidos por el agente',
  })
  totalMinutes: number;

  @ApiProperty({
    example: 'mi-tienda.myshopify.com',
    description: 'Dominio de la tienda Shopify asociada al agente',
    required: false,
    nullable: true,
  })
  shopifyDomain?: string | null;
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
    example: 1738000000000,
    description: 'ID único del agente creado',
  })
  agentId: number;
}
