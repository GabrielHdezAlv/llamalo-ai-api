import { ApiProperty } from '@nestjs/swagger';
import { ComparacionDiaAnteriorDto } from './twilio-detailed-metrics.dto';

export class MetricaConComparacionDto {
  @ApiProperty({
    example: 150,
    description: 'Valor actual de la métrica',
  })
  actual: number;

  @ApiProperty({
    example: 15.5,
    description: 'Variación porcentual respecto a la semana pasada',
  })
  variacionPorcentual: number;
}

export class SummaryDto {
  @ApiProperty({
    description: 'Total de llamadas realizadas con comparación semanal',
    type: MetricaConComparacionDto,
  })
  total_llamadas: MetricaConComparacionDto;

  @ApiProperty({
    description: 'Total de llamadas exitosas con comparación semanal',
    type: MetricaConComparacionDto,
  })
  total_llamadas_exitosas: MetricaConComparacionDto;

  @ApiProperty({
    description: 'Total de minutos del último mes con comparación semanal',
    type: MetricaConComparacionDto,
  })
  minutos_ultimo_mes: MetricaConComparacionDto;

  @ApiProperty({
    description: 'Tiempo ahorrado en minutos con comparación semanal',
    type: MetricaConComparacionDto,
  })
  tiempo_ahorrado: MetricaConComparacionDto;

  @ApiProperty({
    example: 85.5,
    description:
      'Tasa de éxito de las llamadas (porcentaje de llamadas exitosas)',
  })
  tasa_exito: number;
}

export class AgenteDto {
  @ApiProperty({
    example: 'Ana García',
    description: 'Nombre del agente',
  })
  nombre: string;

  @ApiProperty({
    example: 'inbound',
    enum: ['inbound', 'outbound'],
    description: 'Tipo de agente',
  })
  tipo: 'inbound' | 'outbound';

  @ApiProperty({
    example: 75,
    description: 'Minutos totales utilizados por el agente',
  })
  minutos_totales: number;

  @ApiProperty({
    example: 'activo',
    enum: ['activo', 'inactivo'],
    description: 'Estado del agente',
  })
  estado: 'activo' | 'inactivo';
}

export class LlamadaExitosaPorDiaDto {
  @ApiProperty({
    example: '2024-01-15',
    description: 'Fecha en formato YYYY-MM-DD',
  })
  fecha: string;

  @ApiProperty({
    example: 25,
    description: 'Total de llamadas exitosas en ese día',
  })
  total: number;

  @ApiProperty({
    description:
      'Comparación con la misma semana del período anterior (solo para endpoint detallado)',
    required: false,
    type: ComparacionDiaAnteriorDto,
  })
  comparacionSemanaAnterior?: ComparacionDiaAnteriorDto;
}

export class DashboardMetricsResponseDto {
  @ApiProperty({
    type: SummaryDto,
    description: 'Resumen de métricas con comparaciones semanales',
  })
  resumen: SummaryDto;

  @ApiProperty({
    type: [AgenteDto],
    description: 'Lista de agentes con sus métricas',
  })
  agentes: AgenteDto[];

  @ApiProperty({
    type: [LlamadaExitosaPorDiaDto],
    description: 'Llamadas exitosas de los últimos 7 días separadas por día',
  })
  llamadas_exitosas_ultimos_7_dias: LlamadaExitosaPorDiaDto[];
}
