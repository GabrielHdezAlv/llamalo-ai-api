import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { CreateWebhookActionDto } from './dto/create-webhook-action.dto';
import { UpdateWebhookActionDto } from './dto/update-webhook-action.dto';
import {
  WebhookActionsService,
  WebhookActionPublicDto,
} from './webhook-actions.service';

@ApiTags('webhook-actions')
@ApiBearerAuth()
@Controller()
export class WebhookActionsController {
  constructor(private readonly webhookActionsService: WebhookActionsService) {}

  @Get('agents/:agentId/webhook-actions')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Listar acciones webhook (Make) de un agente' })
  @ApiParam({ name: 'agentId', type: Number })
  @ApiResponse({ status: 200 })
  async list(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
  ): Promise<{ items: WebhookActionPublicDto[] }> {
    const items = await this.webhookActionsService.listForAgent(userId, agentId);
    return { items };
  }

  @Post('agents/:agentId/webhook-actions')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Crear acción webhook' })
  @ApiParam({ name: 'agentId', type: Number })
  async create(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Body() dto: CreateWebhookActionDto,
  ) {
    const action = await this.webhookActionsService.create(userId, agentId, dto);
    return { action };
  }

  /** PUT es el verbo canónico; PATCH se acepta por compatibilidad con clientes antiguos. */
  @Put('agents/:agentId/webhook-actions/:actionId')
  @Patch('agents/:agentId/webhook-actions/:actionId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Actualizar acción webhook' })
  @ApiParam({ name: 'agentId', type: Number })
  @ApiParam({ name: 'actionId', type: String })
  async update(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Param('actionId') actionId: string,
    @Body() dto: UpdateWebhookActionDto,
  ) {
    const action = await this.webhookActionsService.update(
      userId,
      agentId,
      actionId,
      dto,
    );
    return { action };
  }

  @Delete('agents/:agentId/webhook-actions/:actionId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Eliminar acción webhook' })
  @ApiParam({ name: 'agentId', type: Number })
  @ApiParam({ name: 'actionId', type: String })
  async remove(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Param('actionId') actionId: string,
  ) {
    return this.webhookActionsService.delete(userId, agentId, actionId);
  }
}
