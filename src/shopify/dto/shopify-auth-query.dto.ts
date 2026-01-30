import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
} from 'class-validator';

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

  @ApiPropertyOptional({
    example: 'https://app.ejemplo.com/dashboard/agents/create',
    description:
      'URL absoluta del frontend a la que redirigir tras el callback de Shopify. Se usa tal cual.',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false })
  returnTo?: string;
}
