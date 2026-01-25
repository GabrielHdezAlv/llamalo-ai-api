import { ApiProperty } from '@nestjs/swagger';
import { AgentDto } from './create-agent-response.dto';

export class ListAgentsResponseDto {
  @ApiProperty({
    type: [AgentDto],
    description: 'Lista de agentes del usuario',
  })
  agents: AgentDto[];
}
