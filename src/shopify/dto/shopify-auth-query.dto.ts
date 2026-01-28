import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ShopifyAuthQueryDto {
  @ApiProperty({
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify (sin https://)',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^[a-zA-Z0-9-]+\.myshopify\.com$/, {
    message: 'El formato del shop debe ser: nombre-tienda.myshopify.com',
  })
  shop: string;
}
