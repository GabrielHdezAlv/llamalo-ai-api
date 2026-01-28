import { ApiProperty } from '@nestjs/swagger';

export class ValidatePhoneResponseDto {
  @ApiProperty({
    example: 'Número verificado correctamente',
    description: 'Mensaje de confirmación',
  })
  message: string;
}
