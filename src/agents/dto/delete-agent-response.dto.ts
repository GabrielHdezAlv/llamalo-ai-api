import { ApiProperty } from '@nestjs/swagger';

export class DeleteAgentResponseDto {
  @ApiProperty({
    example: 'Agente eliminado correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;
}
