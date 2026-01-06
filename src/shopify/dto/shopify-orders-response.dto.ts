import { ApiProperty } from '@nestjs/swagger';

export class ShopifyOrderDto {
  @ApiProperty({ example: 123456789 })
  id: number;

  @ApiProperty({ example: '#1001' })
  name: string;

  @ApiProperty({ example: 'pending' })
  financial_status: string;

  @ApiProperty({ example: 'unfulfilled' })
  fulfillment_status?: string;

  @ApiProperty({ example: '99.99' })
  total_price: string;

  @ApiProperty({ example: 'EUR' })
  currency: string;

  @ApiProperty({ example: '2024-01-01T00:00:00-00:00' })
  created_at: string;

  @ApiProperty({ example: '2024-01-01T00:00:00-00:00' })
  updated_at: string;

  @ApiProperty({ example: {} })
  customer?: unknown;

  @ApiProperty({ example: [] })
  line_items?: unknown[];
}

export class ShopifyOrdersResponseDto {
  @ApiProperty({
    type: [ShopifyOrderDto],
    description: 'Lista de pedidos de la tienda',
  })
  orders: ShopifyOrderDto[];
}

