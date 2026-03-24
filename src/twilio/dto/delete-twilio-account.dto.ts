import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

export class DeleteTwilioAccountDto {
  @ApiProperty({
    example: 1738000000000,
    description: 'ID único de la cuenta de Twilio a eliminar. Si no se proporciona, se eliminan todas.',
    required: false,
  })
  @IsNumber()
  @IsOptional()
  twilioAccountId?: number;
}
