import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ShopifySyncOutboundDto {
  @ApiPropertyOptional({
    description:
      'Ventana hacia atrás en días para listar pedidos (created_at_min). Por defecto 365.',
    example: 365,
    minimum: 1,
    maximum: 730,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  sinceDays?: number;

  @ApiPropertyOptional({
    description:
      'Tope de pedidos a examinar (paginación). Por defecto 5000 para no saturar la API.',
    example: 5000,
    minimum: 1,
    maximum: 25000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25000)
  maxOrders?: number;
}
