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
    example: 1,
    description: 'Estado de la cuenta: 0 = Inactivo, 1 = Activo, 2 = Eliminado',
  })
  accountStatus?: number;

  @ApiProperty({
    example: 'client_user',
    description: 'Rol del usuario: owner o client_user',
  })
  rol?: 'owner' | 'client_user';

  @ApiProperty({
    example: '12 de octubre de 2025, 10:30:45',
    description: 'Fecha de creación formateada en español',
  })
  createdAt?: string | null;

  @ApiProperty({
    description: 'Configuración de Twilio',
    example: [
      {
        twilioAccountId: 1,
        twilioSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        twilioToken: 'your_token',
      },
    ],
  })
  twilio?: Array<{
    twilioAccountId: number;
    twilioSid: string;
    twilioToken: string;
  }>;

  @ApiProperty({
    description:
      'Configuración del agente (compatibilidad: primer agente del array)',
  })
  agent?: Record<string, unknown>;

  @ApiProperty({
    description: 'Integraciones del usuario',
    example: {
      shopify: [
        { connected: true, shopDomain: 'llamaloai-dev.myshopify.com' },
        { connected: true, shopDomain: 'new-llamalo.myshopify.com' },
      ],
    },
  })
  integrations?: {
    shopify?: Array<{
      connected: boolean;
      shopDomain: string;
    }>;
  };

  @ApiProperty({ description: 'Números de teléfono del usuario' })
  phoneNumbers?: Array<{
    phoneId: number;
    countryCode: string;
    number: string;
    state: 'Activo' | 'Inactivo';
    importedBy: string;
    twilioAccountId: number;
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

  @ApiProperty({
    example: true,
    description: 'Indica si el usuario completó el onboarding',
  })
  hasCompletedSetup?: boolean;

  @ApiProperty({
    example: 100,
    description: 'Límite de minutos asignados al usuario',
  })
  minutesLimit?: number;

  @ApiProperty({
    example: 0,
    description: 'Minutos extra asignados al usuario',
  })
  extraMinutes?: number;

  @ApiProperty({
    example: { '2026-01': 150, '2026-02': 320, '2026-03': 87 },
    description: 'Historial de minutos consumidos por mes (formato YYYY-MM)',
  })
  minutesByMonth?: Record<string, number>;

  @ApiProperty({
    required: false,
    description: 'Fin de periodo de prueba (ISO), plan gratis',
  })
  trialEndsAt?: string | null;

  @ApiProperty({
    required: false,
    description: 'Uso vs límites efectivos del plan',
  })
  planUsage?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    description: 'ID de cliente Stripe (facturación)',
  })
  stripeCustomerId?: string | null;

  @ApiProperty({
    required: false,
    description: 'ID de suscripción Stripe',
  })
  stripeSubscriptionId?: string | null;

  @ApiProperty({
    required: false,
    description:
      'Estado de la suscripción en Stripe (trialing, active, past_due, etc.)',
  })
  stripeSubscriptionStatus?: string | null;

  @ApiProperty({
    required: false,
    description:
      'false si aún debe elegir plan o prueba tras registro; true si ya eligió o es cuenta antigua',
  })
  planSelectionCompleted?: boolean;
}
