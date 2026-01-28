import { ApiProperty } from '@nestjs/swagger';

export class CreatePhoneResponseDto {
  @ApiProperty({
    example: 'Número de teléfono añadido correctamente',
    description: 'Mensaje de confirmación',
  })
  message: string;
}
