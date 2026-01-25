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
  async getUserAgents(@GetUser('uid') userId: string) {
    return this.agentsService.getUserAgents(userId);
  }

  @Put('agents/:index')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Actualizar un agente específico por índice' })
  @ApiParam({
    name: 'index',
    type: Number,
    description: 'Índice del agente en el array (empezando desde 0)',
    example: 0,
  })
  @ApiResponse({ status: 200, type: UpdateAgentResponseDto })
  async updateAgent(
    @GetUser('uid') userId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() agentConfig: SetAgentConfigDto,
  ) {
    return this.agentsService.updateAgent(userId, index, agentConfig);
  }

  @Delete('agents/:index')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Eliminar un agente específico por índice' })
  @ApiParam({
    name: 'index',
    type: Number,
    description: 'Índice del agente en el array (empezando desde 0)',
    example: 0,
  })
  @ApiResponse({ status: 200, type: DeleteAgentResponseDto })
  async deleteAgent(
    @GetUser('uid') userId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.agentsService.deleteAgent(userId, index);
  }
}
