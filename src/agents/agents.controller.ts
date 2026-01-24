import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { AgentsService } from './agents.service';
import { AgentDto } from './dto/agent.dto';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { AgentConfigResponseDto } from './dto/agent-config-response.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('agents')
@ApiBearerAuth()
@Controller()
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get('voices/allVoices')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Obtener todas las voces disponibles' })
  @ApiResponse({ status: 200, type: [AgentDto] })
  async getAllAgents() {
    return this.agentsService.getAllAgents();
  }

  @Post('agents/setAgentConfig')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Configurar agente del usuario autenticado' })
  @ApiResponse({ status: 200, type: AgentConfigResponseDto })
  async setAgentConfig(
    @GetUser('uid') userId: string,
    @Body() agentConfig: SetAgentConfigDto,
  ) {
    return this.agentsService.setAgentConfig(userId, agentConfig);
  }
}
