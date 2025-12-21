import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';

export enum PeriodFilter {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  SIX_MONTHS = '6months',
  YEAR = 'year',
}

export class DashboardQueryDto {
  @ApiProperty({
    enum: PeriodFilter,
    required: false,
    default: PeriodFilter.WEEK,
    description: 'Período de filtrado para el resumen',
  })
  @IsOptional()
  @IsEnum(PeriodFilter)
  period?: PeriodFilter = PeriodFilter.WEEK;
}
