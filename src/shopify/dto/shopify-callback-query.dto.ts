import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
    description:
      'ID de sesión OAuth (oauthSessionId) generado en el endpoint /auth',
    required: true,
  })
  @IsNotEmpty()
  @IsString()
  state: string;

  @ApiProperty({
    example:
      '700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf',
    description:
      'HMAC firmado por Shopify para verificar autenticidad del callback',
    required: false,
  })
  @IsOptional()
  @IsString()
  hmac?: string;
}
