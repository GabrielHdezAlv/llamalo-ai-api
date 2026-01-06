import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class ShopifyCallbackQueryDto {
  @ApiProperty({
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify',
  })
  @IsNotEmpty()
  @IsString()
  shop: string;

  @ApiProperty({
    example: 'a1b2c3d4e5f6g7h8i9j0',
    description: 'Código de autorización de Shopify',
  })
  @IsNotEmpty()
  @IsString()
  code: string;

  @ApiProperty({
    example: 'userId123',
    description: 'Estado que contiene el userId (incluido en el flujo OAuth)',
    required: false,
  })
  @IsOptional()
  @IsString()
  state?: string;
}

