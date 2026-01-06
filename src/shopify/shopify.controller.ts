import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ShopifyService } from './shopify.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { ShopifyAuthQueryDto } from './dto/shopify-auth-query.dto';
import { ShopifyCallbackQueryDto } from './dto/shopify-callback-query.dto';
import { ShopifyCallbackResponseDto } from './dto/shopify-callback-response.dto';
import { ShopifyStoreResponseDto } from './dto/shopify-store-response.dto';
import { ShopifyProductsResponseDto } from './dto/shopify-products-response.dto';
import { ShopifyOrdersResponseDto } from './dto/shopify-orders-response.dto';

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('auth')
  @ApiOperation({
    summary: 'Iniciar flujo OAuth de Shopify',
    description:
      'Redirige al usuario al flujo de autorización OAuth de Shopify. Este endpoint es público y no requiere autenticación. El userId debe pasarse como query param para asociar la tienda al usuario.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify (sin https://)',
    required: true,
  })
  @ApiQuery({
    name: 'userId',
    type: String,
    example: 'user123',
    description: 'ID del usuario (se incluirá en el state del OAuth)',
    required: false,
  })
  @ApiResponse({
    status: 302,
    description: 'Redirección a la página de autorización de Shopify',
  })
  @ApiResponse({
    status: 400,
    description: 'Parámetros inválidos',
  })
  async auth(
    @Query() query: ShopifyAuthQueryDto & { userId?: string },
    @Res() res: Response,
  ) {
    try {
      // Construir la URL de callback
      const baseUrl =
        process.env.NODE_ENV === 'production'
          ? process.env.APP_URL || 'https://llamaloiabackend-5294.onrender.com'
          : 'http://localhost:3000';

      const redirectUri = `${baseUrl}/shopify/callback`;

      // Incluir userId en el state para el callback
      // Nota: En producción, deberías encriptar/codificar el userId para mayor seguridad
      const state = query.userId || '';

      // Obtener URL de autorización
      const authUrl = this.shopifyService.getAuthUrl(
        query.shop,
        redirectUri,
        state,
      );

      // Redirigir al usuario
      return res.redirect(authUrl);
    } catch (error) {
      throw new BadRequestException(
        `Error al generar URL de autorización: ${(error as Error).message}`,
      );
    }
  }

  @Get('callback')
  @ApiOperation({
    summary: 'Callback OAuth de Shopify',
    description:
      'Endpoint de callback que recibe el código de autorización de Shopify, lo intercambia por un access_token y lo guarda en la base de datos. Este endpoint es público. El userId debe venir en el parámetro state del flujo OAuth.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify',
    required: true,
  })
  @ApiQuery({
    name: 'code',
    type: String,
    example: 'a1b2c3d4e5f6g7h8i9j0',
    description: 'Código de autorización de Shopify',
    required: true,
  })
  @ApiQuery({
    name: 'state',
    type: String,
    example: 'userId123',
    description: 'Estado que contiene el userId (debe ser incluido en el flujo OAuth)',
    required: false,
  })
  @ApiResponse({
    status: 200,
    type: ShopifyCallbackResponseDto,
    description: 'Token guardado correctamente',
  })
  @ApiResponse({
    status: 400,
    description: 'Código inválido o error en el intercambio',
  })
  @ApiResponse({
    status: 401,
    description: 'Código de autorización inválido o expirado',
  })
  async callback(
    @Query() query: ShopifyCallbackQueryDto & { state?: string },
    @Res() res: Response,
  ) {
    try {
      // Intercambiar código por access_token
      const tokenResponse = await this.shopifyService.exchangeCodeForToken(
        query.shop,
        query.code,
      );

      // Extraer userId del parámetro state
      // Nota: En producción, deberías encriptar/codificar el userId en el state
      // para mayor seguridad. Por ahora, asumimos que viene directamente.
      const userId = query.state;

      if (!userId) {
        throw new BadRequestException(
          'El parámetro state (userId) es requerido. Asegúrate de incluirlo en el flujo OAuth.',
        );
      }

      // Guardar el token en Firestore
      await this.shopifyService.saveAccessToken(
        userId,
        query.shop,
        tokenResponse.access_token,
      );

      return res.json({
        success: true,
        message: 'Token de acceso guardado correctamente',
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Error en callback: ${(error as Error).message}`,
      );
    }
  }

  @Get('store')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obtener información de la tienda Shopify',
    description:
      'Obtiene la información básica de la tienda Shopify conectada. Requiere autenticación Firebase y que la tienda esté previamente conectada.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify',
    required: true,
  })
  @ApiResponse({
    status: 200,
    type: ShopifyStoreResponseDto,
    description: 'Información de la tienda obtenida correctamente',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de acceso inválido o tienda no conectada',
  })
  @ApiResponse({
    status: 403,
    description: 'No autorizado',
  })
  async getStore(
    @GetUser('uid') userId: string,
    @Query('shop') shop: string,
  ) {
    if (!shop) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }

    return this.shopifyService.getStoreInfo(userId, shop);
  }

  @Get('products')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obtener lista de productos de Shopify',
    description:
      'Obtiene la lista de productos de la tienda Shopify conectada. Requiere autenticación Firebase y que la tienda esté previamente conectada.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify',
    required: true,
  })
  @ApiResponse({
    status: 200,
    type: ShopifyProductsResponseDto,
    description: 'Lista de productos obtenida correctamente',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de acceso inválido o tienda no conectada',
  })
  @ApiResponse({
    status: 403,
    description: 'No autorizado',
  })
  async getProducts(
    @GetUser('uid') userId: string,
    @Query('shop') shop: string,
  ) {
    if (!shop) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }

    return this.shopifyService.getProducts(userId, shop);
  }

  @Get('orders')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obtener lista de pedidos de Shopify',
    description:
      'Obtiene la lista de pedidos de la tienda Shopify conectada. Requiere autenticación Firebase y que la tienda esté previamente conectada.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify',
    required: true,
  })
  @ApiResponse({
    status: 200,
    type: ShopifyOrdersResponseDto,
    description: 'Lista de pedidos obtenida correctamente',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de acceso inválido o tienda no conectada',
  })
  @ApiResponse({
    status: 403,
    description: 'No autorizado',
  })
  async getOrders(
    @GetUser('uid') userId: string,
    @Query('shop') shop: string,
  ) {
    if (!shop) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }

    return this.shopifyService.getOrders(userId, shop);
  }
}

