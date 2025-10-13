import { ApiProperty } from '@nestjs/swagger';

export class InboundMinutesDto {
  @ApiProperty({
    example: '150',
    description: 'Minutos consumidos de llamadas entrantes',
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
  })
  message?: string;
}
