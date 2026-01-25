import { ApiProperty } from '@nestjs/swagger';
import { InboundMinutesDto } from './inbound-minutes.dto';

export class TwilioInfoResponseDto {
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
