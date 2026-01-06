import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { getFirestore } from '../firebase/firebase.config';
import * as crypto from 'crypto';

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

interface ShopifyStoreResponse {
  shop: {
    id: number;
    name: string;
    email: string;
    domain: string;
    province?: string;
    country: string;
    currency: string;
    timezone: string;
    created_at: string;
    updated_at: string;
  };
}

interface ShopifyProductsResponse {
  products: unknown[];
}

interface ShopifyOrdersResponse {
  orders: unknown[];
}

@Injectable()
export class ShopifyService {
  private readonly firestore = getFirestore();
  private readonly apiVersion = '2026-01';
  private readonly scopes = [
    'read_products',
    'read_orders',
    'read_customers',
    'read_fulfillments',
    'read_shipping',
  ].join(',');

  /**
   * Genera la URL de autorización OAuth de Shopify
   */
  getAuthUrl(shop: string, redirectUri: string, state?: string): string {
    const apiKey = process.env.SHOPIFY_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'SHOPIFY_API_KEY no configurada en variables de entorno',
      );
    }

    // Normalizar el shop (eliminar https:// si existe)
    const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Usar el state proporcionado o generar uno aleatorio
    const oauthState = state || crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      client_id: apiKey,
      scope: this.scopes,
      redirect_uri: redirectUri,
      state: oauthState,
    });

    return `https://${normalizedShop}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Intercambia el código de autorización por un access_token
   */
  async exchangeCodeForToken(
    shop: string,
    code: string,
  ): Promise<ShopifyTokenResponse> {
    const apiKey = process.env.SHOPIFY_API_KEY;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new InternalServerErrorException(
        'SHOPIFY_API_KEY o SHOPIFY_API_SECRET no configuradas',
      );
    }

    // Normalizar el shop
    const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    try {
      const response = await axios.post<ShopifyTokenResponse>(
        `https://${normalizedShop}/admin/oauth/access_token`,
        {
          client_id: apiKey,
          client_secret: apiSecret,
          code: code,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new UnauthorizedException(
            'Código de autorización inválido o expirado',
          );
        }
        throw new BadRequestException(
          `Error al intercambiar código: ${error.response?.data?.error || error.message}`,
        );
      }
      throw new InternalServerErrorException(
        'Error desconocido al intercambiar código de autorización',
      );
    }
  }

  /**
   * Guarda el access_token en Firestore
   * Nota: Este método es abstracto según las restricciones, pero implementamos la estructura básica
   */
  async saveAccessToken(
    userId: string,
    shop: string,
    accessToken: string,
  ): Promise<void> {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new BadRequestException('Usuario no encontrado');
      }

      // Normalizar el shop
      const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

      // Obtener configuración existente de Shopify o crear nueva
      const userData = userSnapshot.data() as Record<string, unknown>;
      const shopifyConfig =
        (userData?.shopify as Record<string, unknown>) || {};

      // Actualizar o crear la configuración de esta tienda
      const shops = (shopifyConfig.shops as Record<string, unknown>) || {};
      shops[normalizedShop] = {
        accessToken: accessToken,
        connectedAt: new Date().toISOString(),
      };

      // Guardar en Firestore
      await userDocRef.set(
        {
          shopify: {
            ...shopifyConfig,
            shops: shops,
          },
        },
        { merge: true },
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al guardar token: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Obtiene el access_token del usuario para una tienda específica
   */
  async getAccessToken(userId: string, shop: string): Promise<string> {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new UnauthorizedException('Usuario no encontrado');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const shopifyConfig = userData?.shopify as
        | Record<string, unknown>
        | undefined;

      if (!shopifyConfig) {
        throw new UnauthorizedException(
          'No hay tiendas Shopify conectadas para este usuario',
        );
      }

      // Normalizar el shop
      const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

      const shops = shopifyConfig.shops as Record<string, unknown> | undefined;
      if (!shops || !shops[normalizedShop]) {
        throw new UnauthorizedException(
          `No hay token de acceso para la tienda: ${normalizedShop}`,
        );
      }

      const shopData = shops[normalizedShop] as Record<string, unknown>;
      const accessToken = shopData.accessToken as string | undefined;

      if (!accessToken) {
        throw new UnauthorizedException(
          'Token de acceso no encontrado para esta tienda',
        );
      }

      return accessToken;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al obtener token: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Crea una instancia de Axios configurada para llamar a la API de Shopify
   */
  private createShopifyClient(shop: string, accessToken: string): AxiosInstance {
    const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    return axios.create({
      baseURL: `https://${normalizedShop}/admin/api/${this.apiVersion}`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Obtiene información de la tienda
   */
  async getStoreInfo(
    userId: string,
    shop: string,
  ): Promise<ShopifyStoreResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response = await client.get<ShopifyStoreResponse>('/shop.json');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new UnauthorizedException(
            'Token de acceso inválido o expirado. Por favor, reconecta tu tienda.',
          );
        }
        throw new BadRequestException(
          `Error al obtener información de la tienda: ${error.response?.data?.errors || error.message}`,
        );
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error desconocido: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Obtiene la lista de productos
   */
  async getProducts(
    userId: string,
    shop: string,
  ): Promise<ShopifyProductsResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response = await client.get<ShopifyProductsResponse>('/products.json');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new UnauthorizedException(
            'Token de acceso inválido o expirado. Por favor, reconecta tu tienda.',
          );
        }
        throw new BadRequestException(
          `Error al obtener productos: ${error.response?.data?.errors || error.message}`,
        );
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error desconocido: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Obtiene la lista de pedidos
   */
  async getOrders(
    userId: string,
    shop: string,
  ): Promise<ShopifyOrdersResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response = await client.get<ShopifyOrdersResponse>('/orders.json');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new UnauthorizedException(
            'Token de acceso inválido o expirado. Por favor, reconecta tu tienda.',
          );
        }
        throw new BadRequestException(
          `Error al obtener pedidos: ${error.response?.data?.errors || error.message}`,
        );
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error desconocido: ${(error as Error).message}`,
      );
    }
  }
}

