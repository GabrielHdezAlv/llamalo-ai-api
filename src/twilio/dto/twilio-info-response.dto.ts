import { ApiProperty } from '@nestjs/swagger';
import { InboundMinutesDto } from './inbound-minutes.dto';

export class TwilioAccountInfoDto {
  @ApiProperty({
    example: 1,
    description: 'ID de la cuenta de Twilio',
  })
  twilioAccountId: number;

  @ApiProperty({
    example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description: 'Account SID de Twilio',
  })
  twilioSid: string;

  @ApiProperty({
    example: 'your_twilio_auth_token',
    description: 'Auth Token de Twilio',
  })
  twilioToken: string;

  @ApiProperty({
    type: InboundMinutesDto,
    description: 'Información de consumo de minutos de llamadas entrantes',
  })
  inboundMinutes: InboundMinutesDto;
}

export class TwilioInfoResponseDto {
  @ApiProperty({
    type: [TwilioAccountInfoDto],
    description: 'Array de cuentas de Twilio configuradas',
  })
  accounts: TwilioAccountInfoDto[];
}
