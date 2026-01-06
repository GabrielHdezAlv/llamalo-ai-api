import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { getFirestore } from '../firebase/firebase.config';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

interface ShopifyStoreDocument {
  id: string;
  shopDomain: string;
  shopName: string;
  accessToken: string;
  scopes: string[];
  ownerUserId: string;
  status: 'active' | 'revoked';
  createdAt: admin.firestore.Timestamp | Date;
  updatedAt: admin.firestore.Timestamp | Date;
}

interface OAuthSessionDocument {
  id: string;
  userId: string;
  shopDomain: string;
  createdAt: admin.firestore.Timestamp | Date;
  expiresAt: admin.firestore.Timestamp | Date;
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

  /**
   * Scopes de Shopify por defecto (sin read_customers por cumplimiento GDPR)
   * Para agregar read_customers, configurar SHOPIFY_SCOPES en variables de entorno
   *
   * ⚠️ ADVERTENCIA LEGAL:
   * - read_customers da acceso a datos personales (GDPR)
   * - Requiere justificación legal en la UE
   * - Shopify puede solicitar revisión de la app
   * - Solo incluir si es estrictamente necesario
   */
  private readonly scopes = this.getScopes();

  private getScopes(): string {
    // Si hay scopes personalizados en env, usarlos
    const customScopes = process.env.SHOPIFY_SCOPES;
    if (customScopes) {
      return customScopes;
    }

    // Scopes por defecto (sin read_customers para cumplimiento GDPR)
    return [
      'read_products',
      'read_orders',
      'read_fulfillments',
      'read_shipping',
    ].join(',');
  }

  /**
   * Crea una sesión OAuth y retorna el oauthSessionId
   */
  async createOAuthSession(userId: string, shop: string): Promise<string> {
    try {
      // Verificar que el usuario existe
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new BadRequestException('Usuario no encontrado');
      }

      // Normalizar el shop
      const normalizedShop = shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

      // Generar ID único para la sesión
      const sessionId = crypto.randomBytes(32).toString('hex');

      // Crear sesión con expiración de 10 minutos
      const now = admin.firestore.Timestamp.now();
      const expiresAt = new Date(now.toMillis() + 10 * 60 * 1000); // 10 minutos

      const sessionRef = this.firestore
        .collection('oauthSessions')
        .doc(sessionId);
      await sessionRef.set({
        id: sessionId,
        userId: userId,
        shopDomain: normalizedShop,
        createdAt: now,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      });

      return sessionId;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al crear sesión OAuth: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Valida y recupera una sesión OAuth
   */
  async validateOAuthSession(sessionId: string): Promise<OAuthSessionDocument> {
    try {
      const sessionDoc = await this.firestore
        .collection('oauthSessions')
        .doc(sessionId)
        .get();

      if (!sessionDoc.exists) {
        throw new UnauthorizedException('Sesión OAuth no encontrada');
      }

      const sessionData = sessionDoc.data() as OAuthSessionDocument;

      // Verificar expiración
      const expiresAt = sessionData.expiresAt as admin.firestore.Timestamp;
      const now = admin.firestore.Timestamp.now();

      if (expiresAt.toMillis() < now.toMillis()) {
        // Eliminar sesión expirada
        await sessionDoc.ref.delete();
        throw new UnauthorizedException('Sesión OAuth expirada');
      }

      return sessionData;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al validar sesión OAuth: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Elimina una sesión OAuth después de usarla
   */
  async deleteOAuthSession(sessionId: string): Promise<void> {
    try {
      await this.firestore.collection('oauthSessions').doc(sessionId).delete();
    } catch (error) {
      // No lanzar error si falla la eliminación, solo loguear
      console.error(`Error al eliminar sesión OAuth ${sessionId}:`, error);
    }
  }

  /**
   * Genera la URL de autorización OAuth de Shopify usando oauthSessionId como state
   */
  getAuthUrl(
    shop: string,
    redirectUri: string,
    oauthSessionId: string,
  ): string {
    const apiKey = process.env.SHOPIFY_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'SHOPIFY_API_KEY no configurada en variables de entorno',
      );
    }

    // Normalizar el shop (eliminar https:// si existe)
    const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const params = new URLSearchParams({
      client_id: apiKey,
      scope: this.scopes,
      redirect_uri: redirectUri,
      state: oauthSessionId, // Usar oauthSessionId como state
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
   * Guarda el access_token en la colección shopifyStores y actualiza la referencia en users
   */
  async saveAccessToken(
    userId: string,
    shop: string,
    accessToken: string,
    scopes: string,
    shopName?: string,
  ): Promise<void> {
    try {
      // Verificar que el usuario existe
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new BadRequestException('Usuario no encontrado');
      }

      // Normalizar el shop
      const normalizedShop = shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

      // Si no tenemos el shopName, obtenerlo de la API de Shopify
      let finalShopName = shopName;
      if (!finalShopName) {
        try {
          const client = this.createShopifyClient(normalizedShop, accessToken);
          const storeResponse =
            await client.get<ShopifyStoreResponse>('/shop.json');
          finalShopName = storeResponse.data.shop.name;
        } catch {
          // Si falla, usar el dominio como nombre
          finalShopName = normalizedShop;
        }
      }

      // Convertir scopes string a array
      const scopesArray = scopes.split(',').map((s) => s.trim());

      // Buscar si ya existe un documento para esta tienda y usuario
      const existingStoreQuery = await this.firestore
        .collection('shopifyStores')
        .where('shopDomain', '==', normalizedShop)
        .where('ownerUserId', '==', userId)
        .limit(1)
        .get();

      const now = admin.firestore.Timestamp.now();

      if (!existingStoreQuery.empty) {
        // Actualizar documento existente
        const existingDoc = existingStoreQuery.docs[0];
        await existingDoc.ref.update({
          shopName: finalShopName,
          accessToken: accessToken,
          scopes: scopesArray,
          status: 'active',
          updatedAt: now,
        });
      } else {
        // Crear nuevo documento
        const newStoreRef = this.firestore.collection('shopifyStores').doc();
        await newStoreRef.set({
          id: newStoreRef.id,
          shopDomain: normalizedShop,
          shopName: finalShopName,
          accessToken: accessToken,
          scopes: scopesArray,
          ownerUserId: userId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }

      // Actualizar referencia en users
      await userDocRef.set(
        {
          integrations: {
            shopify: {
              connected: true,
              shopDomain: normalizedShop,
            },
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
   * Obtiene el access_token del usuario para una tienda específica desde shopifyStores
   */
  async getAccessToken(userId: string, shop: string): Promise<string> {
    try {
      // Normalizar el shop
      const normalizedShop = shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

      // Buscar en la colección shopifyStores
      const storeQuery = await this.firestore
        .collection('shopifyStores')
        .where('shopDomain', '==', normalizedShop)
        .where('ownerUserId', '==', userId)
        .where('status', '==', 'active')
        .limit(1)
        .get();

      if (storeQuery.empty) {
        throw new UnauthorizedException(
          `No hay tienda Shopify activa conectada para: ${normalizedShop}`,
        );
      }

      const storeDoc = storeQuery.docs[0];
      const storeData = storeDoc.data() as ShopifyStoreDocument;

      if (!storeData.accessToken) {
        throw new UnauthorizedException(
          'Token de acceso no encontrado para esta tienda',
        );
      }

      return storeData.accessToken;
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
  private createShopifyClient(
    shop: string,
    accessToken: string,
  ): AxiosInstance {
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

      const response =
        await client.get<ShopifyProductsResponse>('/products.json');
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

  /**
   * Revoca/desconecta una tienda Shopify
   */
  async revokeStore(userId: string, shop: string): Promise<void> {
    try {
      // Normalizar el shop
      const normalizedShop = shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

      // Buscar la tienda
      const storeQuery = await this.firestore
        .collection('shopifyStores')
        .where('shopDomain', '==', normalizedShop)
        .where('ownerUserId', '==', userId)
        .limit(1)
        .get();

      if (storeQuery.empty) {
        throw new BadRequestException(
          `No se encontró la tienda: ${normalizedShop}`,
        );
      }

      const storeDoc = storeQuery.docs[0];
      const now = admin.firestore.Timestamp.now();

      // Actualizar estado a revoked
      await storeDoc.ref.update({
        status: 'revoked',
        updatedAt: now,
      });

      // Actualizar referencia en users - eliminar la referencia si no hay más tiendas activas
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (userSnapshot.exists) {
        const userData = userSnapshot.data() as Record<string, unknown>;
        const integrations =
          (userData?.integrations as Record<string, unknown>) || {};
        const shopifyIntegration = integrations.shopify as
          | Record<string, unknown>
          | undefined;

        // Verificar si hay otras tiendas activas
        const activeStoresQuery = await this.firestore
          .collection('shopifyStores')
          .where('ownerUserId', '==', userId)
          .where('status', '==', 'active')
          .get();

        if (activeStoresQuery.empty) {
          // No hay más tiendas activas, eliminar referencia
          if (shopifyIntegration) {
            delete integrations.shopify;
            await userDocRef.set({ integrations }, { merge: true });
          }
        } else {
          // Hay otras tiendas activas, actualizar solo si esta era la tienda referenciada
          if (shopifyIntegration?.shopDomain === normalizedShop) {
            // Actualizar a la primera tienda activa disponible
            const firstActiveStore =
              activeStoresQuery.docs[0].data() as ShopifyStoreDocument;
            await userDocRef.set(
              {
                integrations: {
                  ...integrations,
                  shopify: {
                    connected: true,
                    shopDomain: firstActiveStore.shopDomain,
                  },
                },
              },
              { merge: true },
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al revocar tienda: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Limpia sesiones OAuth expiradas (método de mantenimiento)
   * Puede ser llamado periódicamente por un cron job
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const now = admin.firestore.Timestamp.now();
      const expiredSessions = await this.firestore
        .collection('oauthSessions')
        .where('expiresAt', '<', now)
        .get();

      const batch = this.firestore.batch();
      let deletedCount = 0;

      expiredSessions.docs.forEach((doc) => {
        batch.delete(doc.ref);
        deletedCount++;
      });

      if (deletedCount > 0) {
        await batch.commit();
      }

      return deletedCount;
    } catch (error) {
      console.error('Error al limpiar sesiones expiradas:', error);
      return 0;
    }
  }
}
