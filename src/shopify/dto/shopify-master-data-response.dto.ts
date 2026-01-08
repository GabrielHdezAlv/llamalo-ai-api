import { ApiProperty } from '@nestjs/swagger';
import { NormalizedStoreDto } from './shopify-store-response.dto';
import { NormalizedProductDto } from './shopify-products-response.dto';
import { NormalizedOrderDto } from './shopify-orders-response.dto';

export class ShopifyMasterDataResponseDto {
  @ApiProperty({
    type: NormalizedStoreDto,
    description: 'Información normalizada de la tienda',
  })
  store: NormalizedStoreDto;

  @ApiProperty({
    type: [NormalizedProductDto],
    description: 'Lista completa de productos normalizados (puede estar vacía)',
  })
  products: NormalizedProductDto[];

  @ApiProperty({
    type: [NormalizedOrderDto],
    description: 'Lista completa de pedidos normalizados (puede estar vacía)',
  })
  orders: NormalizedOrderDto[];
}
