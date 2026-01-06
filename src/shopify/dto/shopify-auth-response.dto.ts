import { ApiProperty } from '@nestjs/swagger';

export class ShopifyAuthResponseDto {
  @ApiProperty({
    example:
      'https://tu-tienda.myshopify.com/admin/oauth/authorize?client_id=xxx&scope=read_products&redirect_uri=xxx&state=xxx',
    description: 'URL de autorización de Shopify para redirigir al usuario',
  })
  authUrl: string;

  @ApiProperty({
    example: 'Visita esta URL para autorizar la aplicación en Shopify',
    description: 'Mensaje descriptivo',
  })
  message: string;
}

