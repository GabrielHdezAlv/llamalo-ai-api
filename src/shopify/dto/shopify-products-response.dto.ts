import { ApiProperty } from '@nestjs/swagger';

export class NormalizedVariantDto {
  @ApiProperty({ example: 123456789, description: 'ID de la variante' })
  id: number;

  @ApiProperty({ example: 'Talla M / Color Rojo', description: 'Título de la variante' })
  title: string;

  @ApiProperty({
    example: 'SKU-12345',
    description: 'SKU de la variante',
    nullable: true,
  })
  sku: string | null;

  @ApiProperty({ example: 25.99, description: 'Precio (número)' })
  price: number;

  @ApiProperty({
    example: 100,
    description: 'Cantidad en inventario',
    nullable: true,
  })
  inventoryQuantity: number | null;
}

export class NormalizedImageDto {
  @ApiProperty({ example: 987654321, description: 'ID de la imagen' })
  id: number;

  @ApiProperty({
    example: 'https://cdn.shopify.com/s/files/1/0001/0001/products/image.jpg',
    description: 'URL de la imagen',
  })
  src: string;

  @ApiProperty({
    example: 'Imagen del producto',
    description: 'Texto alternativo de la imagen',
    nullable: true,
  })
  altText: string | null;
}

export class NormalizedProductDto {
  @ApiProperty({ example: 123456789, description: 'ID del producto' })
  productId: number;

  @ApiProperty({ example: 'Camiseta de Algodón', description: 'Título del producto' })
  title: string;

  @ApiProperty({ example: 'camiseta-algodon', description: 'Handle del producto' })
  handle: string;

  @ApiProperty({
    example: '<p>Descripción del producto en HTML</p>',
    description: 'Descripción del producto (HTML)',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    example: 'Mi Marca',
    description: 'Vendedor del producto',
    nullable: true,
  })
  vendor: string | null;

  @ApiProperty({
    example: 'Ropa',
    description: 'Tipo de producto',
    nullable: true,
  })
  productType: string | null;

  @ApiProperty({ example: 'active', description: 'Estado del producto' })
  status: string;

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
    type: [NormalizedVariantDto],
    description: 'Variantes del producto',
  })
  variants: NormalizedVariantDto[];

  @ApiProperty({
    type: [NormalizedImageDto],
    description: 'Imágenes del producto',
  })
  images: NormalizedImageDto[];
}

export class ShopifyProductsResponseDto {
  @ApiProperty({
    type: [NormalizedProductDto],
    description: 'Lista de productos normalizados de la tienda',
  })
  products: NormalizedProductDto[];
}

