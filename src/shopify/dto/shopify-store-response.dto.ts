import { ApiProperty } from '@nestjs/swagger';

export class ShopifyStoreResponseDto {
  @ApiProperty({
    example: {
      id: 12345678,
      name: 'Mi Tienda',
      email: 'tienda@example.com',
      domain: 'mi-tienda.myshopify.com',
      province: 'Madrid',
      country: 'ES',
      currency: 'EUR',
      timezone: 'Europe/Madrid',
      created_at: '2024-01-01T00:00:00-00:00',
      updated_at: '2024-01-01T00:00:00-00:00',
    },
    description: 'Información de la tienda Shopify',
  })
  shop: {
    id: number;
    name: string;
    email: string;
    domain: string;
    province?: string;
    country: string;
    currency: string;
    timezone: string;
    created_at: string;
    updated_at: string;
  };
}

