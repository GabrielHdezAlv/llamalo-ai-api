import { Controller, Get, Post, Body, UseGuards, Query, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DashboardMetricsResponseDto } from './dto/dashboard-metrics-response.dto';
import { TwilioDetailedMetricsResponseDto } from './dto/twilio-detailed-metrics.dto';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { BadRequestException } from '@nestjs/common';

@ApiTags('metrics')
@ApiBearerAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('test-latency')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Test endpoint para crear datos de latencia de prueba',
  })
  @ApiResponse({ status: 200, description: 'Datos de latencia creados' })
  async testLatency(@GetUser('uid') userId: string) {
    try {
      const twilioAccountId = 1234567890; // ID de prueba

      // Crear varios datos de latencia de prueba
      const latenciasPrueba = [
        850, 920, 780, 1100, 650, 890, 750, 980, 720, 810,
      ];

      for (const latencia of latenciasPrueba) {
        await this.metricsService.saveLatencyMeasurement(
          userId,
          twilioAccountId,
          latencia,
        );
      }

      return {
        message: 'Datos de latencia de prueba creados',
        userId,
        totalMediciones: latenciasPrueba.length,
        latencias: latenciasPrueba,
      };
    } catch (error) {
      throw new BadRequestException(
        `Error creando datos de prueba: ${(error as Error).message}`,
      );
    }
  }

  @Get('dashboard')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener métricas del dashboard',
    description:
      'Retorna métricas completas del dashboard (llamadas, minutos del mes, comparativas, éxito por día). Los listados de llamadas por período provienen de Firestore (`llamadas_registradas`), escritos al cerrar cada sesión en el backend; no se usa la API REST de Twilio para agregar el dashboard.',
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

  @Post('twilio-webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiExcludeEndpoint()
  async twilioCallWebhook(@Body() body: Record<string, string>): Promise<void> {
    await this.metricsService.handleTwilioCallWebhook(body);
  }

  @Get('twilio-detailed')
  @UseGuards(FirebaseAuthGuard)
  @ApiOperation({
    summary: 'Obtener métricas detalladas de Twilio',
    description:
      'Métricas avanzadas (por día, minutos, duración media, tipos, países, éxito, razones de cuelgue, latencias). Las llamadas del período se leen desde Firestore (`llamadas_registradas`). Twilio en el perfil es opcional para ver histórico tras desvincular; el query `twilioAccountId` filtra por cuenta interna.',
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
    status: 403,
    description:
      'Plan sin panel avanzado (solo Growth o superior pueden usar métricas detalladas)',
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
