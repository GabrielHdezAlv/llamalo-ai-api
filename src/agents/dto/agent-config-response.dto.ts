import { ApiProperty } from '@nestjs/swagger';

export class AgentConfigResponseDto {
  @ApiProperty({
    example: 'Configuración de agente actualizada correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;
}
