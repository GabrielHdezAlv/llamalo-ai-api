import { ApiProperty } from '@nestjs/swagger';

export class InboundMinutesResponseDto {
  @ApiProperty({
    example: '150',
    description: 'Número de minutos consumidos',
  })
  minutes: string;

  @ApiProperty({
    example: 'minutes',
    description: 'Unidad de medida',
  })
  unit?: string;

  @ApiProperty({
    example: 'No hay consumo de llamadas entrantes registrado.',
    description: 'Mensaje informativo',
    required: false,
  })
  message?: string;
}
