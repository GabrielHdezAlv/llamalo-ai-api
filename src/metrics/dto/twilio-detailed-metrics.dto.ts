import { ApiProperty } from '@nestjs/swagger';

export class ComparacionDiaAnteriorDto {
  @ApiProperty({
    description:
      'Total de llamadas exitosas el mismo día de la semana anterior',
    example: 12,
  })
  total: number;

  @ApiProperty({
    description: 'Variación porcentual respecto a la semana anterior',
    example: 25.0,
  })
  variacionPorcentual: number;
}

export class LlamadaExitosaPorDiaDto {
  @ApiProperty({
    description: 'Fecha en formato YYYY-MM-DD',
    example: '2026-02-01',
  })
  fecha: string;

  @ApiProperty({
    description: 'Total de llamadas exitosas en el día',
    example: 15,
  })
  total: number;

  @ApiProperty({
    description: 'Comparación con la misma semana del período anterior',
    required: false,
    type: ComparacionDiaAnteriorDto,
  })
  comparacionSemanaAnterior?: ComparacionDiaAnteriorDto;
}

export class ResumenComparativoSemanalDto {
  @ApiProperty({
    description: 'Total de llamadas exitosas en los últimos 7 días',
    example: 155,
  })
  totalSemanaActual: number;

  @ApiProperty({
    description: 'Total de llamadas exitosas en los 7 días anteriores',
    example: 120,
  })
  totalSemanaAnterior: number;

  @ApiProperty({
    description: 'Variación porcentual entre la semana actual y la anterior',
    example: 29.2,
  })
  variacionPorcentual: number;
}

export class TiposLlamadasDto {
  @ApiProperty({
    description: 'Porcentaje de llamadas entrantes',
    example: 75,
  })
  inbound: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas salientes',
    example: 25,
  })
  outbound: number;
}

export class PaisOrigenDto {
  @ApiProperty({
    description: 'Código del país (ISO 3166-1 alpha-2) o "SIN IDENTIFICAR"',
    example: 'ES',
  })
  pais: string;

  @ApiProperty({
    description: 'Cantidad de llamadas desde ese país',
    example: 45,
  })
  cantidad: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas desde ese país',
    example: 65.2,
  })
  porcentaje: number;
}

export class EvaluacionExitoDto {
  @ApiProperty({
    description: 'Porcentaje de llamadas exitosas',
    example: 85,
  })
  exitosas: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas con éxito parcial',
    example: 10,
  })
  parciales: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas fallidas',
    example: 5,
  })
  fallidas: number;
}

export class RazonesFinalizacionDto {
  @ApiProperty({
    description: 'Número de llamadas completadas con éxito (status: completed)',
    example: 120,
  })
  completada: number;

  @ApiProperty({
    description: 'Número de llamadas canceladas activamente por el cliente (status: canceled)',
    example: 20,
  })
  clienteColgo: number;

  @ApiProperty({
    description: 'Número de llamadas sin respuesta del destino (status: no-answer)',
    example: 10,
  })
  sinRespuesta: number;

  @ApiProperty({
    description: 'Número de llamadas con error técnico (status: failed)',
    example: 5,
  })
  errorTecnico: number;

  @ApiProperty({
    description: 'Número de llamadas con línea ocupada o tiempo agotado (status: busy)',
    example: 3,
  })
  tiempoAgotado: number;
}

export class DailyPeakHour {
  @ApiProperty({
    description: 'Fecha del día (formato: YYYY-MM-DD)',
    example: '2026-02-03',
  })
  date: string;

  @ApiProperty({
    description: 'Hora pico del día (0-23)',
    example: 10,
  })
  peakHour: number;

  @ApiProperty({
    description: 'Número de llamadas en la hora pica',
    example: 12,
  })
  peakCallCount: number;

  @ApiProperty({
    description: 'Total de llamadas ese día',
    example: 45,
  })
  totalDayCalls: number;

  @ApiProperty({
    description:
      'Array de 24 posiciones, cada índice representa una hora del día',
    example: [
      0, 0, 0, 0, 0, 2, 5, 8, 12, 6, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    type: [Number],
  })
  hourlyCalls: number[];
}

export class CallMetricsDto {
  @ApiProperty({
    description: 'Fecha de inicio del período (7 días atrás)',
    example: '2026-02-03T00:00:00.000Z',
  })
  startDate: Date;

  @ApiProperty({
    description: 'Fecha de fin del período (actual)',
    example: '2026-02-09T23:59:59.999Z',
  })
  endDate: Date;

  @ApiProperty({
    description: 'Array con la hora pico de cada día',
    type: [DailyPeakHour],
  })
  dailyPeakHours: DailyPeakHour[];

  @ApiProperty({
    description: 'Total de llamadas en el período',
    example: 127,
  })
  totalCalls: number;
}

export class TwilioDetailedMetricsResponseDto {
  @ApiProperty({
    description: 'Llamadas exitosas de los últimos 7 días divididas por día',
    type: [LlamadaExitosaPorDiaDto],
  })
  llamadasExitosasUltimos7Dias: LlamadaExitosaPorDiaDto[];

  @ApiProperty({
    description: 'Resumen comparativo semanal de llamadas exitosas',
    type: ResumenComparativoSemanalDto,
  })
  resumenComparativoSemanal: ResumenComparativoSemanalDto;

  @ApiProperty({
    description: 'Total de minutos de todas las llamadas del último mes',
    example: 1250,
  })
  totalMinutosUltimoMes: number;

  @ApiProperty({
    description: 'Duración media de las llamadas en minutos',
    example: 4.5,
  })
  duracionMediaLlamadas: number;

  @ApiProperty({
    description: 'Distribución porcentual de tipos de llamadas',
    type: TiposLlamadasDto,
  })
  tiposLlamadas: TiposLlamadasDto;

  @ApiProperty({
    description: 'Países de donde provienen las llamadas',
    type: [PaisOrigenDto],
  })
  paisesOrigen: PaisOrigenDto[];

  @ApiProperty({
    description: 'Evaluación porcentual del éxito de las llamadas',
    type: EvaluacionExitoDto,
  })
  evaluacionExito: EvaluacionExitoDto;

  @ApiProperty({
    description: 'Razones de finalización de las llamadas',
    type: RazonesFinalizacionDto,
  })
  razonesFinalizacion: RazonesFinalizacionDto;

  @ApiProperty({
    description: 'Latencia media de respuesta del agente en milisegundos',
    example: 850,
    required: false,
  })
  latenciaMedia?: number;

  @ApiProperty({
    description: 'Métricas de llamadas por hora para análisis de hora pico',
    type: CallMetricsDto,
    required: false,
  })
  callMetricsByHour?: CallMetricsDto;
}
