import { ApiProperty } from '@nestjs/swagger';

export class NormalizedLineItemDto {
  @ApiProperty({ example: 123456789, description: 'ID del line item' })
  id: number;

  @ApiProperty({
    example: 987654321,
    description: 'ID del producto',
    nullable: true,
  })
  productId: number | null;

  @ApiProperty({
    example: 111222333,
    description: 'ID de la variante',
    nullable: true,
  })
  variantId: number | null;

  @ApiProperty({
    example: 'Camiseta - Talla M',
    description: 'Título del item',
  })
  title: string;

  @ApiProperty({ example: 2, description: 'Cantidad' })
  quantity: number;

  @ApiProperty({ example: 25.99, description: 'Precio (número)' })
  price: number;

  @ApiProperty({ example: 'EUR', description: 'Moneda' })
  currency: string;
}

export class NormalizedCustomerDto {
  @ApiProperty({
    example: 123456789,
    description: 'ID del cliente',
    nullable: true,
  })
  id: number | null;

  @ApiProperty({
    example: 'Juan',
    description: 'Nombre del cliente',
    nullable: true,
  })
  firstName: string | null;

  @ApiProperty({
    example: 'Pérez',
    description: 'Apellido del cliente',
    nullable: true,
  })
  lastName: string | null;

  @ApiProperty({
    example: 'juan.perez@example.com',
    description: 'Email del cliente',
    nullable: true,
  })
  email: string | null;
}

export class NormalizedOrderDto {
  @ApiProperty({ example: 123456789, description: 'ID del pedido' })
  orderId: number;

  @ApiProperty({ example: '#1001', description: 'Nombre/número del pedido' })
  orderName: string;

  @ApiProperty({ example: 'paid', description: 'Estado financiero del pedido' })
  status: string;

  @ApiProperty({
    example: 'fulfilled',
    description: 'Estado de fulfillment',
    nullable: true,
  })
  fulfillmentStatus: string | null;

  @ApiProperty({ example: 99.99, description: 'Precio total (número)' })
  totalPrice: number;

  @ApiProperty({ example: 'EUR', description: 'Moneda' })
  currency: string;

  @ApiProperty({
    example: '2024-01-01T00:00:00-00:00',
    description: 'Fecha de creación (ISO)',
  })
  createdAt: string;

  @ApiProperty({
    example: '2024-01-01T00:00:00-00:00',
    description: 'Fecha de actualización (ISO)',
  })
  updatedAt: string;

  @ApiProperty({
    type: NormalizedCustomerDto,
    description: 'Información del cliente',
    nullable: true,
  })
  customer: NormalizedCustomerDto | null;

  @ApiProperty({
    type: [NormalizedLineItemDto],
    description: 'Items del pedido',
  })
  lineItems: NormalizedLineItemDto[];
}

export class ShopifyOrdersResponseDto {
  @ApiProperty({
    type: [NormalizedOrderDto],
    description: 'Lista de pedidos normalizados de la tienda',
  })
  orders: NormalizedOrderDto[];
}
