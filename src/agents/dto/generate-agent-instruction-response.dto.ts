import { ApiProperty } from '@nestjs/swagger';

export class GenerateAgentInstructionResponseDto {
  @ApiProperty({
    example:
      '============================================================\nINSTRUCCIONES...\n============================================================',
    description: 'Texto final de instrucciones del agente',
  })
  agentInstruction: string;
}
