import { ApiProperty } from '@nestjs/swagger';

export class UserProfileResponseDto {
  @ApiProperty({ example: 'abc123', description: 'ID del usuario' })
  userId: string;

  @ApiProperty({ example: 'Juan', description: 'Nombre del usuario' })
  name?: string;

  @ApiProperty({ example: 'Pérez', description: 'Apellido del usuario' })
  lastname?: string;

  @ApiProperty({
    example: 'https://storage.googleapis.com/...',
    description: 'URL de la imagen de perfil',
  })
  profileImage?: string;

  @ApiProperty({
    example: { name: 'Mi Empresa S.A.', url: 'https://miempresa.com' },
    description: 'Información de la empresa',
  })
  enterprise?: {
    name: string;
    url: string;
  };

  @ApiProperty({
    example: 'juan.perez@gmail.com',
    description: 'Email del usuario',
  })
  email?: string;

  @ApiProperty({
    example: 'ES',
    description: 'Código de país del usuario',
  })
  country?: string;

  @ApiProperty({
    example: true,
    description: 'Consentimiento de marketing',
  })
  marketingConsent?: boolean;

  @ApiProperty({
    example: '12 de octubre de 2025, 10:30:45',
    description: 'Fecha de creación formateada en español',
  })
  createdAt?: string | null;

  @ApiProperty({ description: 'Configuración de Twilio' })
  twilio?: Record<string, unknown>;

  @ApiProperty({ description: 'Configuración del agente (compatibilidad: primer agente del array)' })
  agent?: Record<string, unknown>;

  @ApiProperty({ description: 'Integraciones del usuario' })
  integrations?: {
    shopify?: {
      connected: boolean;
      shopDomain: string;
    };
  };

  @ApiProperty({ description: 'Números de teléfono del usuario' })
  phoneNumbers?: Array<{
    phoneId: number;
    countryCode: string;
    number: string;
    state: 'Activo' | 'Inactivo';
    importedBy: string;
  }>;

  @ApiProperty({ description: 'Agentes configurados del usuario' })
  agents?: Array<{
    name: string;
    type: 'outbound' | 'inbound';
    language: string;
    voiceId: string;
    firstInteraction: string;
    agentInstruction: string;
    phoneNumbers: {
      phoneId: number;
      countryCode: string;
      number: string;
    };
    label: string;
    state: 'Activo' | 'Inactivo';
    parameters: {
      stability: number;
      similarity: number;
      style: number;
      boost: boolean;
      speed: number;
    };
    totalMinutes: number;
  }>;
}
