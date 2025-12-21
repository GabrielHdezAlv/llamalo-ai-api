import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { DashboardQueryDto, PeriodFilter } from './dto/dashboard-query.dto';
import { DashboardMetricsResponseDto } from './dto/dashboard-metrics-response.dto';
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
      'Retorna resumen de llamadas, agentes y llamadas de los últimos 7 días. El resumen se puede filtrar por período.',
  })
  @ApiResponse({
    status: 200,
    type: DashboardMetricsResponseDto,
    description: 'Métricas del dashboard obtenidas correctamente',
  })
  async getDashboardMetrics(
    @GetUser('uid') userId: string,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardMetricsResponseDto> {
    return this.metricsService.getDashboardMetrics(
      userId,
      query.period || PeriodFilter.WEEK,
    );
  }
}
