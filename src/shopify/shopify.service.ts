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

export interface ShopifyStoreResponse {
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

export interface ShopifyProductsResponse {
  products: unknown[];
}

export interface ShopifyOrdersResponse {
  orders: unknown[];
}

// Interfaces para pedidos normalizados
export interface NormalizedLineItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  title: string;
  quantity: number;
  price: number;
  currency: string;
}

export interface NormalizedCustomer {
  id: number | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface NormalizedOrder {
  orderId: number;
  orderName: string;
  status: string;
  fulfillmentStatus: string | null;
  totalPrice: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  customer: NormalizedCustomer | null;
  lineItems: NormalizedLineItem[];
}

export interface NormalizedOrdersResponse {
  orders: NormalizedOrder[];
}

// Interfaces para productos normalizados
export interface NormalizedVariant {
  id: number;
  title: string;
  sku: string | null;
  price: number;
  inventoryQuantity: number | null;
}

export interface NormalizedImage {
  id: number;
  src: string;
  altText: string | null;
}

export interface NormalizedProduct {
  productId: number;
  title: string;
  handle: string;
  description: string | null;
  vendor: string | null;
  productType: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  variants: NormalizedVariant[];
  images: NormalizedImage[];
}

export interface NormalizedProductsResponse {
  products: NormalizedProduct[];
}

// Interfaces para tienda normalizada
export interface NormalizedStore {
  storeId: number;
  name: string;
  domain: string;
  email: string;
  province: string | null;
  country: string;
  currency: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedStoreResponse {
  store: NormalizedStore;
}

// Interface para datos maestros combinados
export interface ShopifyMasterDataResponse {
  store: NormalizedStore;
  products: NormalizedProduct[];
  orders: NormalizedOrder[];
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

      // Actualizar referencia en users - añadir o actualizar en el array
      const userData = userSnapshot.data() as Record<string, unknown>;
      const integrations =
        (userData?.integrations as Record<string, unknown>) || {};
      const currentShopifyArray =
        (integrations.shopify as Array<{
          connected: boolean;
          shopDomain: string;
        }>) || [];

      // Buscar si esta tienda ya existe en el array
      const existingIndex = currentShopifyArray.findIndex(
        (store) => store.shopDomain === normalizedShop,
      );

      let updatedShopifyArray: Array<{
        connected: boolean;
        shopDomain: string;
      }>;

      if (existingIndex !== -1) {
        // Actualizar la tienda existente
        updatedShopifyArray = [...currentShopifyArray];
        updatedShopifyArray[existingIndex] = {
          connected: true,
          shopDomain: normalizedShop,
        };
      } else {
        // Añadir nueva tienda al array
        updatedShopifyArray = [
          ...currentShopifyArray,
          {
            connected: true,
            shopDomain: normalizedShop,
          },
        ];
      }

      await userDocRef.set(
        {
          integrations: {
            shopify: updatedShopifyArray,
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
   * Obtiene información de la tienda normalizada
   */
  async getStoreInfo(
    userId: string,
    shop: string,
  ): Promise<NormalizedStoreResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response = await client.get<ShopifyStoreResponse>('/shop.json');
      const shopData = response.data.shop;

      // Transformar al formato normalizado
      const normalizedStore: NormalizedStore = {
        storeId: shopData.id || 0,
        name: shopData.name || '',
        domain: shopData.domain || '',
        email: shopData.email || '',
        province: shopData.province || null,
        country: shopData.country || '',
        currency: shopData.currency || '',
        timezone: shopData.timezone || '',
        createdAt: shopData.created_at || new Date().toISOString(),
        updatedAt: shopData.updated_at || new Date().toISOString(),
      };

      return {
        store: normalizedStore,
      };
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
   * Obtiene la lista de productos normalizados
   */
  async getProducts(
    userId: string,
    shop: string,
  ): Promise<NormalizedProductsResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response =
        await client.get<ShopifyProductsResponse>('/products.json');
      const rawProducts = response.data.products as Array<
        Record<string, unknown>
      >;

      // Transformar cada producto al formato normalizado
      const normalizedProducts: NormalizedProduct[] = rawProducts.map(
        (product) => {
          // Normalizar variants
          const normalizedVariants: NormalizedVariant[] = [];
          if (Array.isArray(product.variants)) {
            normalizedVariants.push(
              ...product.variants.map((variant: Record<string, unknown>) => ({
                id: (variant.id as number) || 0,
                title: (variant.title as string) || '',
                sku: (variant.sku as string) || null,
                price: parseFloat((variant.price as string) || '0'),
                inventoryQuantity:
                  (variant.inventory_quantity as number) ?? null,
              })),
            );
          }

          // Normalizar images
          const normalizedImages: NormalizedImage[] = [];
          if (Array.isArray(product.images)) {
            normalizedImages.push(
              ...product.images.map((image: Record<string, unknown>) => ({
                id: (image.id as number) || 0,
                src: (image.src as string) || '',
                altText: (image.alt as string) || null,
              })),
            );
          }

          return {
            productId: (product.id as number) || 0,
            title: (product.title as string) || '',
            handle: (product.handle as string) || '',
            description: (product.body_html as string) || null,
            vendor: (product.vendor as string) || null,
            productType: (product.product_type as string) || null,
            status: (product.status as string) || '',
            createdAt:
              (product.created_at as string) || new Date().toISOString(),
            updatedAt:
              (product.updated_at as string) || new Date().toISOString(),
            variants: normalizedVariants,
            images: normalizedImages,
          };
        },
      );

      return {
        products: normalizedProducts,
      };
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
   * Obtiene la lista de pedidos normalizados
   */
  async getOrders(
    userId: string,
    shop: string,
  ): Promise<NormalizedOrdersResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      const response = await client.get<ShopifyOrdersResponse>('/orders.json');
      const rawOrders = response.data.orders as Array<Record<string, unknown>>;

      // Transformar cada pedido al formato normalizado
      const normalizedOrders: NormalizedOrder[] = rawOrders.map((order) => {
        // Normalizar customer
        let normalizedCustomer: NormalizedCustomer | null = null;
        if (order.customer && typeof order.customer === 'object') {
          const customer = order.customer as Record<string, unknown>;
          normalizedCustomer = {
            id: (customer.id as number) || null,
            firstName: (customer.first_name as string) || null,
            lastName: (customer.last_name as string) || null,
            email: (customer.email as string) || null,
          };
        }

        // Normalizar line items
        const normalizedLineItems: NormalizedLineItem[] = [];
        if (Array.isArray(order.line_items)) {
          normalizedLineItems.push(
            ...order.line_items.map((item: Record<string, unknown>) => ({
              id: (item.id as number) || 0,
              productId: (item.product_id as number) || null,
              variantId: (item.variant_id as number) || null,
              title: (item.title as string) || '',
              quantity: (item.quantity as number) || 0,
              price: parseFloat((item.price as string) || '0'),
              currency:
                (item.currency as string) ||
                (order.currency as string) ||
                'USD',
            })),
          );
        }

        // Convertir total_price de string a número
        const totalPrice = parseFloat((order.total_price as string) || '0');

        return {
          orderId: (order.id as number) || 0,
          orderName: (order.name as string) || '',
          status: (order.financial_status as string) || '',
          fulfillmentStatus: (order.fulfillment_status as string) || null,
          totalPrice: totalPrice,
          currency: (order.currency as string) || 'USD',
          createdAt: (order.created_at as string) || new Date().toISOString(),
          updatedAt: (order.updated_at as string) || new Date().toISOString(),
          customer: normalizedCustomer,
          lineItems: normalizedLineItems,
        };
      });

      return {
        orders: normalizedOrders,
      };
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
   * Busca pedidos por email del cliente
   * Retorna todos los pedidos asociados a ese email, ordenados por fecha (más reciente primero)
   */
  async searchOrdersByEmail(
    userId: string,
    shop: string,
    email: string,
  ): Promise<NormalizedOrdersResponse> {
    try {
      // Obtener todos los pedidos
      const allOrders = await this.getOrders(userId, shop);

      // Filtrar por email (case-insensitive)
      const filteredOrders = allOrders.orders.filter(
        (order) => order.customer?.email?.toLowerCase() === email.toLowerCase(),
      );

      // Ordenar por fecha de creación (más reciente primero)
      filteredOrders.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return {
        orders: filteredOrders,
      };
    } catch (error) {
      // Re-lanzar errores de getOrders
      throw error;
    }
  }

  /**
   * Busca un pedido específico por su número (orderName, ej: "#1001")
   * Retorna el pedido si existe, o un array vacío si no se encuentra
   */
  async searchOrderByNumber(
    userId: string,
    shop: string,
    orderName: string,
  ): Promise<NormalizedOrdersResponse> {
    try {
      // Normalizar el número de pedido (agregar # si no lo tiene)
      const normalizedOrderName = orderName.startsWith('#')
        ? orderName
        : `#${orderName}`;

      // Obtener todos los pedidos
      const allOrders = await this.getOrders(userId, shop);

      // Buscar el pedido específico
      const foundOrder = allOrders.orders.find(
        (order) => order.orderName === normalizedOrderName,
      );

      return {
        orders: foundOrder ? [foundOrder] : [],
      };
    } catch (error) {
      // Re-lanzar errores de getOrders
      throw error;
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

      // Actualizar referencia en users - eliminar del array
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (userSnapshot.exists) {
        const userData = userSnapshot.data() as Record<string, unknown>;
        const integrations =
          (userData?.integrations as Record<string, unknown>) || {};
        const shopifyArray =
          (integrations.shopify as Array<{
            connected: boolean;
            shopDomain: string;
          }>) || [];

        // Filtrar la tienda revocada del array
        const updatedShopifyArray = shopifyArray.filter(
          (store) => store.shopDomain !== normalizedShop,
        );

        // Actualizar en users
        if (updatedShopifyArray.length === 0) {
          // Si no quedan tiendas, eliminar la propiedad shopify
          delete integrations.shopify;
          await userDocRef.set({ integrations }, { merge: true });
        } else {
          // Si quedan tiendas, actualizar el array
          await userDocRef.set(
            {
              integrations: {
                shopify: updatedShopifyArray,
              },
            },
            { merge: true },
          );
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
   * Obtiene todos los datos maestros de la tienda (store, products, orders) en un solo objeto
   * Útil para análisis, dashboards o envío a otros sistemas
   */
  async getMasterData(
    userId: string,
    shop: string,
  ): Promise<ShopifyMasterDataResponse> {
    try {
      // Obtener los tres conjuntos de datos en paralelo para mejor rendimiento
      const [storeResponse, productsResponse, ordersResponse] =
        await Promise.all([
          this.getStoreInfo(userId, shop),
          this.getProducts(userId, shop),
          this.getOrders(userId, shop),
        ]);

      // Combinar en un objeto maestro
      return {
        store: storeResponse.store,
        products: productsResponse.products, // Array completo, puede estar vacío []
        orders: ordersResponse.orders, // Array completo, puede estar vacío []
      };
    } catch (error) {
      // Re-lanzar errores de los métodos subyacentes
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Error al obtener datos maestros: ${(error as Error).message}`,
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
