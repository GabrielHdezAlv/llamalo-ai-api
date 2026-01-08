import {
  Controller,
  Get,
  Query,
  Res,
  Req,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import type { Response, Request } from 'express';
import { ShopifyService } from './shopify.service';
import type {
  NormalizedStoreResponse,
  NormalizedProductsResponse,
  NormalizedOrdersResponse,
} from './shopify.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUser } from '../auth/get-user.decorator';
import { ShopifyAuthQueryDto } from './dto/shopify-auth-query.dto';
import { ShopifyCallbackQueryDto } from './dto/shopify-callback-query.dto';
import { ShopifyCallbackResponseDto } from './dto/shopify-callback-response.dto';
import { ShopifyStoreResponseDto } from './dto/shopify-store-response.dto';
import { ShopifyProductsResponseDto } from './dto/shopify-products-response.dto';
import { ShopifyOrdersResponseDto } from './dto/shopify-orders-response.dto';
import { ShopifyAuthResponseDto } from './dto/shopify-auth-response.dto';

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('auth')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Iniciar flujo OAuth de Shopify',
    description:
      'Crea una sesión OAuth segura y redirige al usuario al flujo de autorización de Shopify. Requiere autenticación Firebase. Si la petición viene de Swagger, automáticamente devuelve la URL en JSON en lugar de redirigir. También puedes usar redirect=false para forzar el modo JSON.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'llamaloai-dev.myshopify.com',
    description: 'Dominio de la tienda Shopify (sin https://)',
    required: true,
  })
  @ApiQuery({
    name: 'redirect',
    type: Boolean,
    example: true,
    description:
      'Si es false, devuelve la URL en JSON en lugar de redirigir. Nota: Swagger se detecta automáticamente y devuelve JSON sin necesidad de este parámetro.',
    required: false,
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirección a la página de autorización de Shopify (cuando redirect=true o no se especifica)',
  })
  @ApiResponse({
    status: 200,
    type: ShopifyAuthResponseDto,
    description: 'URL de autorización en JSON (cuando redirect=false)',
  })
  @ApiResponse({
    status: 400,
    description: 'Parámetros inválidos',
  })
  @ApiResponse({
    status: 401,
    description: 'No autorizado',
  })
  async auth(
    @GetUser('uid') userId: string,
    @Query() query: ShopifyAuthQueryDto & { redirect?: string },
    @Res() res: Response,
    @Req() req: Request,
  ) {
    try {
      // Detectar si la petición viene de Swagger
      // Swagger UI típicamente envía referer con /api o swagger en la URL
      const referer = req.headers['referer'] || '';
      const userAgent = req.headers['user-agent'] || '';
      const isFromSwagger =
        query.redirect === 'false' ||
        referer.includes('/api') ||
        referer.includes('swagger') ||
        userAgent.includes('Swagger');

      // Crear sesión OAuth segura
      const oauthSessionId = await this.shopifyService.createOAuthSession(
        userId,
        query.shop,
      );

      // Construir la URL de callback
      const baseUrl =
        process.env.NODE_ENV === 'production'
          ? process.env.APP_URL || 'https://llamaloiabackend-5294.onrender.com'
          : 'http://localhost:3000';

      const redirectUri = `${baseUrl}/shopify/callback`;

      // Obtener URL de autorización con oauthSessionId como state
      const authUrl = this.shopifyService.getAuthUrl(
        query.shop,
        redirectUri,
        oauthSessionId,
      );

      // Si viene de Swagger, devolver JSON automáticamente
      if (isFromSwagger) {
        return res.json({
          authUrl: authUrl,
          message: 'Visita esta URL para autorizar la aplicación en Shopify',
        });
      }

      // Por defecto, redirigir
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
      'Endpoint de callback que recibe el código de autorización de Shopify. Valida la sesión OAuth, intercambia el código por access_token y lo guarda en la base de datos. Este endpoint es público.',
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
    example: 'oauthSessionId123',
    description: 'ID de sesión OAuth (oauthSessionId)',
    required: true,
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
    description:
      'Sesión OAuth inválida, expirada o código de autorización inválido',
  })
  async callback(
    @Query() query: ShopifyCallbackQueryDto,
    @Res() res: Response,
  ) {
    try {
      if (!query.state) {
        throw new BadRequestException(
          'El parámetro state (oauthSessionId) es requerido',
        );
      }

      // Validar sesión OAuth y recuperar userId
      const oauthSession = await this.shopifyService.validateOAuthSession(
        query.state,
      );

      // Verificar que el shopDomain coincide
      const normalizedShop = query.shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');
      if (oauthSession.shopDomain !== normalizedShop) {
        throw new BadRequestException(
          'El dominio de la tienda no coincide con la sesión OAuth',
        );
      }

      // Intercambiar código por access_token
      const tokenResponse = await this.shopifyService.exchangeCodeForToken(
        query.shop,
        query.code,
      );

      // Guardar el token en shopifyStores y actualizar referencia en users
      await this.shopifyService.saveAccessToken(
        oauthSession.userId,
        query.shop,
        tokenResponse.access_token,
        tokenResponse.scope,
      );

      // Eliminar sesión OAuth después de usarla (one-time use)
      await this.shopifyService.deleteOAuthSession(query.state);

      return res.json({
        success: true,
        message: 'Token de acceso guardado correctamente',
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
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
  ): Promise<NormalizedStoreResponse> {
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
  ): Promise<NormalizedProductsResponse> {
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
  ): Promise<NormalizedOrdersResponse> {
    if (!shop) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }

    return this.shopifyService.getOrders(userId, shop);
  }
}
