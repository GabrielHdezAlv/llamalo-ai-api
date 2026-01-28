import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { AgentsService } from './agents.service';
import { AgentDto } from './dto/agent.dto';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { CreateAgentResponseDto } from './dto/create-agent-response.dto';
import { UpdateAgentResponseDto } from './dto/update-agent-response.dto';
import { ListAgentsResponseDto } from './dto/list-agents-response.dto';
import { DeleteAgentResponseDto } from './dto/delete-agent-response.dto';
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
  async getAllVoices() {
    return this.agentsService.getAllAgents();
  }

  @Post('agents')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Crear un nuevo agente' })
  @ApiResponse({ status: 201, type: CreateAgentResponseDto })
  async createAgent(
    @GetUser('uid') userId: string,
    @Body() agentConfig: SetAgentConfigDto,
  ) {
    return this.agentsService.createAgent(userId, agentConfig);
  }

  @Get('agents')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Listar todos los agentes del usuario' })
  @ApiResponse({ status: 200, type: ListAgentsResponseDto })
  async getUserAgents(
    @GetUser('uid') userId: string,
    @Query('q') query?: string,
  ) {
    return this.agentsService.getUserAgents(userId, query);
  }

  @Put('agents/:agentId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Actualizar un agente específico por agentId' })
  @ApiParam({
    name: 'agentId',
    type: Number,
    description: 'ID único del agente',
    example: 1738000000000,
  })
  @ApiResponse({ status: 200, type: UpdateAgentResponseDto })
  async updateAgent(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Body() agentConfig: SetAgentConfigDto,
  ) {
    return this.agentsService.updateAgent(userId, agentId, agentConfig);
  }

  @Delete('agents/:agentId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Eliminar un agente específico por agentId' })
  @ApiParam({
    name: 'agentId',
    type: Number,
    description: 'ID único del agente',
    example: 1738000000000,
  })
  @ApiResponse({ status: 200, type: DeleteAgentResponseDto })
  async deleteAgent(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
  ) {
    return this.agentsService.deleteAgent(userId, agentId);
  }
}
