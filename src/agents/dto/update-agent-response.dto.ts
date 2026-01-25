import { ApiProperty } from '@nestjs/swagger';
import { AgentDto } from './create-agent-response.dto';

export class UpdateAgentResponseDto {
  @ApiProperty({
    example: 'Agente actualizado correctamente.',
    description: 'Mensaje de confirmación',
  })
  message: string;

  @ApiProperty({ type: AgentDto, description: 'Agente actualizado' })
  agent: AgentDto;
}
