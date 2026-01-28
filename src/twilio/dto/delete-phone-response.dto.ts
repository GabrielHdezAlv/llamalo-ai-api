import { ApiProperty } from '@nestjs/swagger';

export class DeletePhoneResponseDto {
  @ApiProperty({
    example: 'Número de teléfono eliminado correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({
    example: 2,
    description: 'Número de agentes afectados (que tenían este número)',
  })
  affectedAgents: number;
}
