import {
  Controller,
  Get,
  Post,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
  Res,
  Req,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import * as Sentry from '@sentry/nestjs';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response, Request } from 'express';
import { ShopifyService } from './shopify.service';
import type {
  NormalizedStoreResponse,
  NormalizedProductsResponse,
  NormalizedOrdersResponse,
  ShopifyMasterDataResponse,
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
import { ShopifyMasterDataResponseDto } from './dto/shopify-master-data-response.dto';

@ApiTags('shopify')
@Controller('shopify')
export class ShopifyController {
  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly planLimitsService: PlanLimitsService,
  ) {}

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
  @ApiQuery({
    name: 'returnTo',
    type: String,
    example: 'https://app.ejemplo.com/dashboard/agents/create',
    description:
      'URL absoluta del frontend a la que redirigir tras autorizar en Shopify. Se usa tal cual en el callback.',
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
      await this.planLimitsService.assertShopifyIntegrationAllowed(userId);
      // Detectar si la petición viene de Swagger
      // Swagger UI típicamente envía referer con /api o swagger en la URL
      const referer = req.headers['referer'] || '';
      const userAgent = req.headers['user-agent'] || '';
      const isFromSwagger =
        query.redirect === 'false' ||
        referer.includes('/api') ||
        referer.includes('swagger') ||
        userAgent.includes('Swagger');

      // Crear sesión OAuth segura (returnTo se guarda para redirigir tras el callback)
      const oauthSessionId = await this.shopifyService.createOAuthSession(
        userId,
        query.shop,
        query.returnTo,
      );

      // Misma URL que en Shopify Partners → Allowed redirection URL(s) (p. ej. …/shopify/callback).
      const redirectUri = `${this.shopifyService.getPublicApiBaseUrl()}/shopify/callback`;

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
      if (error instanceof ForbiddenException) {
        throw error;
      }
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
    status: 302,
    description:
      'Redirección al frontend (URL enviada en returnTo) con ?shopify=success&shop=...',
  })
  @ApiResponse({
    status: 200,
    type: ShopifyCallbackResponseDto,
    description:
      'Token guardado correctamente (solo si no se envió returnTo en /auth)',
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
    const getRedirectBase = (frontendRedirectUrl?: string): string | null => {
      return frontendRedirectUrl && frontendRedirectUrl.trim()
        ? frontendRedirectUrl.trim()
        : null;
    };

    const redirectToFrontend = (
      base: string,
      params: {
        shopify: string;
        shop?: string;
        code?: string;
        message?: string;
      },
    ) => {
      const url = new URL(base);
      Object.entries(params).forEach(([k, v]) => {
        if (v != null && v !== '') url.searchParams.set(k, v);
      });
      return res.redirect(302, url.toString());
    };

    try {
      if (!query.state) {
        const base = getRedirectBase();
        if (base) {
          return redirectToFrontend(base, {
            shopify: 'error',
            code: '400',
            message: 'state requerido',
          });
        }
        throw new BadRequestException(
          'El parámetro state (oauthSessionId) es requerido',
        );
      }

      // Validar sesión OAuth y recuperar userId
      const oauthSession = await this.shopifyService.validateOAuthSession(
        query.state,
      );
      await this.planLimitsService.assertShopifyIntegrationAllowed(
        oauthSession.userId,
      );
      const redirectBase = getRedirectBase(oauthSession.frontendRedirectUrl);

      // Verificar que el shopDomain coincide
      const normalizedShop = query.shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');
      if (oauthSession.shopDomain !== normalizedShop) {
        if (redirectBase) {
          return redirectToFrontend(redirectBase, {
            shopify: 'error',
            code: '400',
            message: 'dominio no coincide con la sesión',
          });
        }
        throw new BadRequestException(
          'El dominio de la tienda no coincide con la sesión OAuth',
        );
      }

      // Validar HMAC firmado por Shopify (antes del intercambio de token)
      const apiSecret = process.env.SHOPIFY_API_SECRET;
      if (!query.hmac) {
        if (redirectBase) {
          return redirectToFrontend(redirectBase, {
            shopify: 'error',
            code: '401',
            message: 'HMAC requerido',
          });
        }
        throw new UnauthorizedException('HMAC requerido');
      }
      if (!apiSecret) {
        if (redirectBase) {
          return redirectToFrontend(redirectBase, {
            shopify: 'error',
            code: '401',
            message: 'Configuración de app inválida',
          });
        }
        throw new UnauthorizedException('SHOPIFY_API_SECRET no configurada');
      }
      const queryRecord = query as unknown as Record<
        string,
        string | string[] | undefined
      >;
      if (!this.shopifyService.validateShopifyHmac(queryRecord, apiSecret)) {
        if (redirectBase) {
          return redirectToFrontend(redirectBase, {
            shopify: 'error',
            code: '401',
            message: 'HMAC inválido',
          });
        }
        throw new UnauthorizedException('HMAC inválido');
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

      if (redirectBase) {
        return redirectToFrontend(redirectBase, {
          shopify: 'success',
          shop: normalizedShop,
        });
      }

      return res.json({
        success: true,
        message: 'Token de acceso guardado correctamente',
      });
    } catch (error) {
      const base = getRedirectBase();
      if (base) {
        const code = error instanceof UnauthorizedException ? '401' : '400';
        const message =
          error instanceof Error ? error.message : 'Error en callback';
        return redirectToFrontend(base, {
          shopify: 'error',
          code,
          message: message.slice(0, 200),
        });
      }
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

  @Get('master-data')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obtener datos maestros de la tienda Shopify',
    description:
      'Obtiene todos los datos normalizados de la tienda (store, products, orders) en un solo objeto. Útil para análisis, dashboards o envío a otros sistemas. Requiere autenticación Firebase y que la tienda esté previamente conectada.',
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
    type: ShopifyMasterDataResponseDto,
    description:
      'Datos maestros obtenidos correctamente. Los arrays de products y orders siempre estarán presentes, incluso si están vacíos.',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de acceso inválido o tienda no conectada',
  })
  @ApiResponse({
    status: 403,
    description: 'No autorizado',
  })
  async getMasterData(
    @GetUser('uid') userId: string,
    @Query('shop') shop: string,
  ): Promise<ShopifyMasterDataResponse> {
    if (!shop) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }

    return this.shopifyService.getMasterData(userId, shop);
  }

  @Delete('connection')
  @UseGuards(FirebaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Desvincular tienda Shopify',
    description:
      'Revoca la tienda para el usuario autenticado: elimina el token en Firestore, quita la entrada en integrations.shopify y limpia shopifyDomain en agentes que usaran esa tienda.',
  })
  @ApiQuery({
    name: 'shop',
    type: String,
    example: 'mi-tienda.myshopify.com',
    description: 'Dominio de la tienda (sin https://)',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Tienda desvinculada',
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Parámetro shop faltante o tienda no encontrada',
  })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async disconnectConnection(
    @GetUser('uid') userId: string,
    @Query('shop') shop: string,
  ): Promise<{ message: string }> {
    if (!shop?.trim()) {
      throw new BadRequestException('El parámetro shop es obligatorio');
    }
    await this.shopifyService.revokeStore(userId, shop.trim());
    return { message: 'Tienda Shopify desvinculada correctamente.' };
  }

  @Post('webhooks')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Webhook receiver para Shopify',
    description: 'Recibe eventos asíncronos de Shopify, como app/uninstalled.',
  })
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-shopify-topic') topic: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-hmac-sha256') hmac: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
  ) {
    if (!topic || !shopDomain || !hmac || !webhookId) {
      throw new BadRequestException('Faltan headers obligatorios de Shopify');
    }

    // Validar HMAC
    const apiSecret = process.env.SHOPIFY_API_SECRET;
    if (!apiSecret) {
      console.error('SHOPIFY_API_SECRET no está configurado');
      throw new UnauthorizedException('Configuración inválida');
    }

    if (!req.rawBody) {
      console.error(
        'El req.rawBody no está disponible. ¿Está configurado el middleware en main.ts?',
      );
      throw new BadRequestException(
        'No se puede validar el webhook (falta rawBody)',
      );
    }

    const isValid = this.shopifyService.validateShopifyWebhookHmac(
      req.rawBody,
      hmac,
      apiSecret,
    );

    if (!isValid) {
      console.error(`HMAC inválido para el webhook ${topic} de ${shopDomain}`);
      throw new UnauthorizedException('HMAC inválido');
    }

    // Idempotencia: ¿Ya hemos procesado este webhook?
    const isDuplicate = await this.shopifyService.verifyWebhookIdempotency(
      webhookId,
      topic,
      shopDomain,
    );

    if (isDuplicate) {
      console.log(
        `[Idempotencia] Ignorando webhook duplicado: ${webhookId} (${topic})`,
      );
      return { success: true, message: 'Webhook already processed' }; // Retornar 200 INMEDIATO
    }

    Sentry.setTag('webhook', 'shopify');
    Sentry.setTag('shopify_topic', topic);
    Sentry.setContext('shopify_webhook', { topic, shopDomain, webhookId });

    // Manejar topics específicos
    if (topic === 'app/uninstalled') {
      // Procesar en background para responder rápido a Shopify (timeout = 5s)
      this.shopifyService.handleAppUninstalled(shopDomain).catch((err) => {
        console.error(
          `Error procesando webhook app/uninstalled para ${shopDomain}:`,
          err,
        );
        Sentry.captureException(err, {
          tags: { webhook: 'shopify', shopify_topic: 'app/uninstalled' },
          extra: { shopDomain, webhookId },
        });
      });
    } else if (topic === 'checkouts/update') {
      let checkoutBody: Record<string, unknown>;
      try {
        checkoutBody = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        checkoutBody = {};
      }
      void this.shopifyService
        .handleOutboundCheckoutWebhook(shopDomain, checkoutBody)
        .catch((err) => {
          console.error(
            `Error webhook checkouts/update ${shopDomain}:`,
            err,
          );
          Sentry.captureException(err, {
            tags: { webhook: 'shopify', shopify_topic: topic },
            extra: { shopDomain, webhookId },
          });
        });
    } else if (topic === 'orders/paid') {
      let orderBody: Record<string, unknown>;
      try {
        orderBody = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        orderBody = {};
      }
      void this.shopifyService
        .handleOrdersPaidOutboundWebhook(shopDomain, orderBody)
        .catch((err) => {
          console.error(`Error webhook orders/paid ${shopDomain}:`, err);
          Sentry.captureException(err, {
            tags: { webhook: 'shopify', shopify_topic: topic },
            extra: { shopDomain, webhookId },
          });
        });
    } else if (topic === 'orders/create') {
      let orderBody: Record<string, unknown>;
      try {
        orderBody = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        orderBody = {};
      }
      void this.shopifyService
        .handleOrdersCreateOutboundWebhook(shopDomain, orderBody)
        .catch((err) => {
          console.error(`Error webhook orders/create ${shopDomain}:`, err);
          Sentry.captureException(err, {
            tags: { webhook: 'shopify', shopify_topic: topic },
            extra: { shopDomain, webhookId },
          });
        });
    } else {
      console.log(
        `Webhook recibido y aceptado: ${topic} para la tienda ${shopDomain}`,
      );
    }

    return { success: true };
  }
}
