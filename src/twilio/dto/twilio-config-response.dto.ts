import { ApiProperty } from '@nestjs/swagger';

export class TwilioConfigResponseDto {
  @ApiProperty({
    example: 'Configuración de Twilio actualizada correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;
}
