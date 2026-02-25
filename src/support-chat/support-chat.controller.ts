import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SupportChatService } from './support-chat.service';
import {
  SupportAgentConfigResponseDto,
  CreateSupportSourceDto,
} from './dto/support-chat.dto';
import { SetAgentConfigDto } from '../agents/dto/set-agent-config.dto';
import { KnowledgeSourceDto } from '../knowledge-base/dto/knowledge-source.dto';
import type { Express } from 'express';

@ApiTags('support-agent')
@Controller('support-agent')
export class SupportChatController {
  constructor(private readonly supportChatService: SupportChatService) {}

  // ── Configuración (mismo DTO que edición de agente + contactEmail, model) ───

  @Get('config')
  @ApiOperation({
    summary: 'Obtener configuración del agente de soporte (Xenon)',
  })
  @ApiResponse({ status: 200, type: SupportAgentConfigResponseDto })
  async getConfig(): Promise<SupportAgentConfigResponseDto> {
    return this.supportChatService.getConfig();
  }

  @Put('config')
  @ApiOperation({
    summary: 'Actualizar configuración del agente de soporte',
    description:
      'Mismo body que la edición de un agente (SetAgentConfigDto) más contactEmail y model opcionales.',
  })
  @ApiResponse({ status: 200, type: SupportAgentConfigResponseDto })
  async updateConfig(
    @Body() dto: SetAgentConfigDto,
  ): Promise<SupportAgentConfigResponseDto> {
    return this.supportChatService.updateConfig(dto);
  }

  // ── Fuentes de conocimiento ───────────────────────────────────────────────

  @Post('sources')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir fuente de conocimiento para el agente de soporte',
    description:
      'Permite subir PDFs, URLs o texto plano que alimentan al agente de soporte.',
  })
  @ApiResponse({ status: 201, type: KnowledgeSourceDto })
  async createSource(
    @Body() dto: CreateSupportSourceDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<KnowledgeSourceDto> {
    const filePath = file ? file.path : undefined;
    return this.supportChatService.createSource(dto, filePath);
  }

  @Get('sources')
  @ApiOperation({
    summary: 'Listar fuentes de conocimiento del agente de soporte',
  })
  @ApiResponse({ status: 200, type: [KnowledgeSourceDto] })
  async getSources(): Promise<KnowledgeSourceDto[]> {
    return this.supportChatService.getSources();
  }

  @Delete('sources/:sourceId')
  @ApiOperation({ summary: 'Eliminar una fuente de conocimiento' })
  @ApiParam({
    name: 'sourceId',
    description: 'ID de la fuente de conocimiento',
    example: 'src_1234567890_abc123',
  })
  @ApiResponse({ status: 200 })
  async deleteSource(@Param('sourceId') sourceId: string) {
    return this.supportChatService.deleteSource(sourceId);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Probar búsqueda en la base de conocimiento del soporte',
    description:
      'Permite probar cómo responde la búsqueda vectorial contra las fuentes del agente de soporte.',
  })
  @ApiQuery({ name: 'q', description: 'Consulta de búsqueda' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Límite de resultados (default: 5)',
  })
  @ApiResponse({ status: 200 })
  async search(@Query('q') query: string, @Query('limit') limit?: string) {
    return this.supportChatService.searchKnowledge(
      query,
      limit ? parseInt(limit, 10) : 5,
    );
  }
}
