import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { TwilioService } from './twilio.service';
import { TwilioConfigDto } from './dto/twilio-config.dto';
import { TwilioConfigResponseDto } from './dto/twilio-config-response.dto';
import { TwilioInfoResponseDto } from './dto/twilio-info-response.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('twilio')
@ApiBearerAuth()
@Controller('twilio')
export class TwilioController {
  constructor(private readonly twilioService: TwilioService) {}

  @Post('config')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({ summary: 'Configurar credenciales de Twilio del usuario' })
  @ApiResponse({ status: 200, type: TwilioConfigResponseDto })
  async setConfig(
    @GetUser('uid') userId: string,
    @Body() config: TwilioConfigDto,
  ) {
    return this.twilioService.setTwilioConfig(userId, config);
  }

  @Get('info')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener configuración de Twilio y minutos consumidos',
  })
  @ApiResponse({ status: 200, type: TwilioInfoResponseDto })
  async getInfo(@GetUser('uid') userId: string) {
    return this.twilioService.getTwilioInfo(userId);
  }
}
