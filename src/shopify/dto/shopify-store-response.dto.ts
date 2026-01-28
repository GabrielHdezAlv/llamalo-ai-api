import { ApiProperty } from '@nestjs/swagger';

export class NormalizedStoreDto {
  @ApiProperty({ example: 12345678, description: 'ID de la tienda' })
  storeId: number;

  @ApiProperty({ example: 'Mi Tienda', description: 'Nombre de la tienda' })
  name: string;

  @ApiProperty({
    example: 'mi-tienda.myshopify.com',
    description: 'Dominio de la tienda',
  })
  domain: string;

  @ApiProperty({
    example: 'tienda@example.com',
    description: 'Email de contacto de la tienda',
  })
  email: string;

  @ApiProperty({
    example: 'Madrid',
    description: 'Provincia de la tienda',
    nullable: true,
  })
  province: string | null;

  @ApiProperty({ example: 'ES', description: 'Código de país de la tienda' })
  country: string;

  @ApiProperty({
    example: 'EUR',
    description: 'Moneda principal de la tienda',
  })
  currency: string;

  @ApiProperty({
    example: 'Europe/Madrid',
    description: 'Zona horaria de la tienda',
  })
  timezone: string;

  @ApiProperty({
    example: '2024-01-01T00:00:00-00:00',
    description: 'Fecha de creación (ISO)',
  })
  createdAt: string;

  @ApiProperty({
    example: '2024-01-01T00:00:00-00:00',
    description: 'Fecha de última actualización (ISO)',
  })
  updatedAt: string;
}

export class ShopifyStoreResponseDto {
  @ApiProperty({
    type: NormalizedStoreDto,
    description: 'Información normalizada de la tienda Shopify',
  })
  store: NormalizedStoreDto;
}
