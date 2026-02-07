import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DashboardMetricsResponseDto } from './dto/dashboard-metrics-response.dto';
import { TwilioDetailedMetricsResponseDto } from './dto/twilio-detailed-metrics.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('metrics')
@ApiBearerAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('dashboard')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener métricas del dashboard',
    description:
      'Retorna resumen de llamadas, agentes y llamadas de los últimos 7 días. Los datos siempre corresponden a los últimos 7 días.',
  })
  @ApiResponse({
    status: 200,
    type: DashboardMetricsResponseDto,
    description: 'Métricas del dashboard obtenidas correctamente',
  })
  async getDashboardMetrics(
    @GetUser('uid') userId: string,
  ): Promise<DashboardMetricsResponseDto> {
    return this.metricsService.getDashboardMetrics(userId);
  }

  @Get('twilio-detailed')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener métricas detalladas de Twilio',
    description:
      'Retorna métricas avanzadas de Twilio incluyendo llamadas exitosas por día, minutos del mes, duración media, tipos de llamadas, países de origen, evaluación de éxito y razones de finalización. ' +
      'Si no se especifica twilioAccountId, se usará la primera cuenta de Twilio configurada.',
  })
  @ApiQuery({
    name: 'twilioAccountId',
    required: false,
    description:
      'ID de la cuenta de Twilio para obtener métricas específicas (opcional)',
    example: 1234567890,
  })
  @ApiResponse({
    status: 200,
    type: TwilioDetailedMetricsResponseDto,
    description: 'Métricas detalladas de Twilio obtenidas correctamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario o cuenta de Twilio no encontrada',
  })
  async getTwilioDetailedMetrics(
    @GetUser('uid') userId: string,
    @Query('twilioAccountId') twilioAccountId?: number,
  ): Promise<TwilioDetailedMetricsResponseDto> {
    return this.metricsService.getTwilioDetailedMetrics(
      userId,
      twilioAccountId,
    );
  }
}
