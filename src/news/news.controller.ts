import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NewsService } from './news.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';

@ApiTags('news')
@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todas las noticias (público o autenticado)' })
  async getAllNews() {
    return this.newsService.getAllNews();
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Crear una nueva noticia (solo owner)' })
  async createNews(
    @GetUser('uid') userId: string,
    @Body() createNewsDto: CreateNewsDto,
  ) {
    return this.newsService.createNews(userId, createNewsDto);
  }

  @Put(':id')
  @ApiBearerAuth()
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Actualizar una noticia existente (solo owner)' })
  async updateNews(
    @GetUser('uid') userId: string,
    @Param('id') id: string,
    @Body() updateNewsDto: UpdateNewsDto,
  ) {
    return this.newsService.updateNews(userId, id, updateNewsDto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Eliminar una noticia (solo owner)' })
  async deleteNews(
    @GetUser('uid') userId: string,
    @Param('id') id: string,
  ) {
    return this.newsService.deleteNews(userId, id);
  }
}
