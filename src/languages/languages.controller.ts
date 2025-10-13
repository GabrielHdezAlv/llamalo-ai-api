import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { LanguagesService } from './languages.service';
import { LanguageDto } from './dto/language.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@ApiTags('languages')
@ApiBearerAuth()
@Controller('languages')
export class LanguagesController {
  constructor(private readonly languagesService: LanguagesService) {}

  @Get('allLanguages')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Obtener todos los idiomas disponibles' })
  @ApiResponse({ status: 200, type: [LanguageDto] })
  async getAllLanguages() {
    return this.languagesService.getAllLanguages();
  }
}
