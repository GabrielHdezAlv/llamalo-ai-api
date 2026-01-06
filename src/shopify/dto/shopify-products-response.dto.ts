import { ApiProperty } from '@nestjs/swagger';

export class ShopifyProductDto {
  @ApiProperty({ example: 123456789 })
  id: number;

  @ApiProperty({ example: 'Producto Ejemplo' })
  title: string;

  @ApiProperty({ example: 'producto-ejemplo' })
  handle: string;

  @ApiProperty({ example: 'Descripción del producto' })
  body_html?: string;

  @ApiProperty({ example: 'vendor-ejemplo' })
  vendor?: string;

  @ApiProperty({ example: 'product-type' })
  product_type?: string;

  @ApiProperty({ example: '2024-01-01T00:00:00-00:00' })
  created_at: string;

  @ApiProperty({ example: '2024-01-01T00:00:00-00:00' })
  updated_at: string;

  @ApiProperty({ example: 'active' })
  status: string;

  @ApiProperty({ example: [] })
  variants?: unknown[];

  @ApiProperty({ example: [] })
  images?: unknown[];
}

export class ShopifyProductsResponseDto {
  @ApiProperty({
    type: [ShopifyProductDto],
    description: 'Lista de productos de la tienda',
  })
  products: ShopifyProductDto[];
}

