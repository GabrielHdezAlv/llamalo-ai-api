import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class TwilioConfigDto {
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
