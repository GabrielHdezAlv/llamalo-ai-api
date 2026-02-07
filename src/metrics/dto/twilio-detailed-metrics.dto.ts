import { ApiProperty } from '@nestjs/swagger';

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
    description: 'Porcentaje de llamadas completadas con éxito',
    example: 80,
  })
  completada: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas donde el cliente colgó',
    example: 15,
  })
  clienteColgo: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas con error técnico',
    example: 3,
  })
  errorTecnico: number;

  @ApiProperty({
    description: 'Porcentaje de llamadas por tiempo agotado',
    example: 2,
  })
  tiempoAgotado: number;
}

export class TwilioDetailedMetricsResponseDto {
  @ApiProperty({
    description: 'Llamadas exitosas de los últimos 7 días divididas por día',
    type: [LlamadaExitosaPorDiaDto],
  })
  llamadasExitosasUltimos7Dias: LlamadaExitosaPorDiaDto[];

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
}
