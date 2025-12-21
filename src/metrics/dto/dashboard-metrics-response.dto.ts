import { ApiProperty } from '@nestjs/swagger';

export class SummaryDto {
  @ApiProperty({
    example: 150,
    description: 'Total de llamadas realizadas',
  })
  total_llamadas: number;

  @ApiProperty({
    example: 375,
    description: 'Tiempo ahorrado en minutos (minutos_utilizados × 2.5)',
  })
  tiempo_ahorrado: number;

  @ApiProperty({
    example: 150,
    description: 'Minutos totales utilizados en llamadas',
  })
  minutos_utilizados: number;
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

export class LlamadaPorDiaDto {
  @ApiProperty({
    example: '2024-01-15',
    description: 'Fecha en formato YYYY-MM-DD',
  })
  fecha: string;

  @ApiProperty({
    example: 25,
    description: 'Total de llamadas en ese día',
  })
  total: number;
}

export class DashboardMetricsResponseDto {
  @ApiProperty({
    type: SummaryDto,
    description: 'Resumen de métricas',
  })
  resumen: SummaryDto;

  @ApiProperty({
    type: [AgenteDto],
    description: 'Lista de agentes con sus métricas',
  })
  agentes: AgenteDto[];

  @ApiProperty({
    type: [LlamadaPorDiaDto],
    description: 'Llamadas de los últimos 7 días',
  })
  llamadas_ultimos_7_dias: LlamadaPorDiaDto[];
}
