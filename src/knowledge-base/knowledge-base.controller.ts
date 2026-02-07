import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiConsumes,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { KnowledgeBaseService } from './knowledge-base.service';
import {
  CreateKnowledgeSourceDto,
  UpdateKnowledgeSourceDto,
  KnowledgeSourceDto,
  SearchKnowledgeDto,
  LinkKnowledgeToAgentDto,
} from './dto/knowledge-source.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('knowledge-base')
@ApiBearerAuth()
@Controller()
export class KnowledgeBaseController {
  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  @Post('knowledge-base/sources')
  @UseGuards(FirebaseAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a new knowledge source' })
  @ApiResponse({ status: 201, type: KnowledgeSourceDto })
  async createSource(
    @GetUser('uid') userId: string,
    @Body() createSourceDto: CreateKnowledgeSourceDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const filePath = file ? file.path : undefined;
    return this.knowledgeBaseService.createKnowledgeSource(
      userId,
      createSourceDto,
      filePath,
    );
  }

  @Get('knowledge-base/sources')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Get all knowledge sources for user' })
  @ApiResponse({ status: 200, type: [KnowledgeSourceDto] })
  async getSources(@GetUser('uid') userId: string) {
    return this.knowledgeBaseService.getUserSources(userId);
  }

  @Put('knowledge-base/sources/:sourceId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Update a knowledge source' })
  @ApiParam({
    name: 'sourceId',
    description: 'ID of the knowledge source',
    example: 'src_1234567890_abc123',
  })
  @ApiResponse({ status: 200, type: KnowledgeSourceDto })
  async updateSource(
    @Param('sourceId') sourceId: string,
    @Body() updateDto: UpdateKnowledgeSourceDto,
  ) {
    return this.knowledgeBaseService.updateKnowledgeSource(sourceId, updateDto);
  }

  @Delete('knowledge-base/sources/:sourceId')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Delete a knowledge source' })
  @ApiParam({
    name: 'sourceId',
    description: 'ID of the knowledge source',
    example: 'src_1234567890_abc123',
  })
  @ApiResponse({ status: 200 })
  async deleteSource(@Param('sourceId') sourceId: string) {
    return this.knowledgeBaseService.deleteKnowledgeSource(sourceId);
  }

  @Post('knowledge-base/search')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Search in knowledge base' })
  @ApiResponse({ status: 200 })
  async searchKnowledge(@Body() searchDto: SearchKnowledgeDto) {
    return this.knowledgeBaseService.searchKnowledge(searchDto);
  }

  @Post('knowledge-base/agents/:agentId/sources')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Link knowledge sources to an agent' })
  @ApiParam({
    name: 'agentId',
    type: Number,
    description: 'ID of the agent',
    example: 1738000000000,
  })
  @ApiResponse({ status: 200 })
  async linkSourcesToAgent(
    @GetUser('uid') userId: string,
    @Param('agentId', ParseIntPipe) agentId: number,
    @Body() linkDto: LinkKnowledgeToAgentDto,
  ) {
    return this.knowledgeBaseService.linkSourcesToAgent(
      agentId,
      userId,
      linkDto,
    );
  }

  @Get('knowledge-base/agents/:agentId/sources')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Get knowledge sources linked to an agent' })
  @ApiParam({
    name: 'agentId',
    type: Number,
    description: 'ID of the agent',
    example: 1738000000000,
  })
  @ApiResponse({ status: 200 })
  async getAgentKnowledgeSources(@Param('agentId', ParseIntPipe) agentId: number) {
    return this.knowledgeBaseService.getAgentKnowledgeSources(agentId);
  }

  @Get('knowledge-base/sources/:sourceId/preview')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Get preview of processed knowledge source' })
  @ApiParam({
    name: 'sourceId',
    description: 'ID of the knowledge source',
    example: 'src_1234567890_abc123',
  })
  @ApiResponse({ status: 200 })
  async getSourcePreview(@Param('sourceId') sourceId: string) {
    // This would be implemented to show a preview of the processed content
    // For now, returning a placeholder
    return {
      sourceId,
      preview: 'Preview functionality would be implemented here',
    };
  }
}
