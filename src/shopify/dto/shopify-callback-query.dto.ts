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
    example: 'oauthSessionId123',
    description: 'ID de sesión OAuth (oauthSessionId) generado en el endpoint /auth',
    required: true,
  })
  @IsNotEmpty()
  @IsString()
  state: string;
}

