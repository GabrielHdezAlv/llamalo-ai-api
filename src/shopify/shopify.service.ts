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
import { CryptoService } from '../crypto/crypto.service';

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
  /** URL del frontend a la que redirigir tras el callback (opcional) */
  frontendRedirectUrl?: string;
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

  constructor(private readonly cryptoService: CryptoService) {}

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

    // Scopes por defecto (con read_customers para búsqueda de caller)
    return [
      'read_products',
      'read_orders',
      'read_customers',
      'read_fulfillments',
      'read_shipping',
    ].join(',');
  }

  /**
   * Crea una sesión OAuth y retorna el oauthSessionId.
   * Si se pasa returnTo (URL del frontend), se guarda tal cual para redirigir tras el callback.
   */
  async createOAuthSession(
    userId: string,
    shop: string,
    returnTo?: string,
  ): Promise<string> {
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

      const frontendRedirectUrl =
        returnTo && typeof returnTo === 'string' && returnTo.trim()
          ? returnTo.trim()
          : undefined;

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
        ...(frontendRedirectUrl && { frontendRedirectUrl }),
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
   * Valida que el HMAC del callback OAuth de Shopify coincida con el firmado por nosotros.
   * Excluye el parámetro hmac, ordena el resto alfabéticamente y firma con HMAC-SHA256 usando el client secret.
   * @see https://shopify.dev/docs/apps/build/authentication-authorization/get-access-tokens/auth-code-grant/implement-auth-code-grants-manually
   */
  validateShopifyHmac(
    query: Record<string, string | string[] | undefined>,
    secret: string,
  ): boolean {
    const receivedHmac =
      typeof query.hmac === 'string'
        ? query.hmac
        : Array.isArray(query.hmac)
          ? query.hmac[0]
          : undefined;
    if (!receivedHmac || !secret) return false;

    const params = { ...query };
    delete params.hmac;

    const message = Object.keys(params)
      .sort()
      .map((key) => {
        const raw = params[key];
        const value =
          raw === undefined ? '' : Array.isArray(raw) ? raw[0] : String(raw);
        return `${key}=${value}`;
      })
      .join('&');

    const computed = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    if (receivedHmac.length !== computed.length) return false;
    try {
      const receivedBuf = Buffer.from(receivedHmac, 'hex');
      const computedBuf = Buffer.from(computed, 'hex');
      if (receivedBuf.length !== computedBuf.length) return false;
      return crypto.timingSafeEqual(receivedBuf, computedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Valida el HMAC de un webhook de Shopify.
   * Mensaje = raw body; firma en header X-Shopify-Hmac-Sha256 (base64).
   * Reutilizable para cualquier endpoint que reciba webhooks.
   * @see https://shopify.dev/docs/apps/build/webhooks/subscribe/https
   */
  validateShopifyWebhookHmac(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    secret: string,
  ): boolean {
    if (!signatureHeader || !secret) return false;
    const bodyBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, 'utf8');
    const computed = crypto
      .createHmac('sha256', secret)
      .update(bodyBuffer)
      .digest('base64');
    try {
      const receivedBuf = Buffer.from(signatureHeader, 'base64');
      const computedBuf = Buffer.from(computed, 'base64');
      if (receivedBuf.length !== computedBuf.length) return false;
      return crypto.timingSafeEqual(receivedBuf, computedBuf);
    } catch {
      return false;
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
      const encryptedToken = this.cryptoService.encrypt(accessToken);

      if (!existingStoreQuery.empty) {
        // Actualizar documento existente
        const existingDoc = existingStoreQuery.docs[0];
        await existingDoc.ref.update({
          shopName: finalShopName,
          accessToken: encryptedToken,
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
          accessToken: encryptedToken,
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

      // Asegurar que shopify sea un array (manejar formato antiguo o valores inválidos)
      const currentShopifyArray: Array<{
        connected: boolean;
        shopDomain: string;
      }> = Array.isArray(integrations.shopify) ? integrations.shopify : [];

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

      // Registrar el webhook app/uninstalled de forma asíncrona (sin bloquear)
      this.registerUninstallWebhook(normalizedShop, accessToken).catch(
        (err) => {
          console.error(
            `Error al registrar webhook de desinstalación para ${normalizedShop}:`,
            err,
          );
        },
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

      // Descifrar el token de acceso
      return this.cryptoService.decrypt(storeData.accessToken);
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

    const client = axios.create({
      baseURL: `https://${normalizedShop}/admin/api/${this.apiVersion}`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    // Interceptor para manejar rate limits (429 Too Many Requests)
    client.interceptors.response.use(
      (response) => response,
      async (error) => {
        // Si no es error de axios, no tiene respuesta, o no es 429, rechazar directo
        if (
          !axios.isAxiosError(error) ||
          !error.response ||
          error.response.status !== 429 ||
          !error.config
        ) {
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        const config = error.config as typeof error.config & {
          __retryCount?: number;
        };

        config.__retryCount = config.__retryCount || 0;

        // Límite estricto de 3 reintentos
        if (config.__retryCount >= 3) {
          console.error(
            `[Shopify API] Max retries (3) alcanzado por rate limit (429) en la tienda: ${normalizedShop}`,
          );
          return Promise.reject(error);
        }

        config.__retryCount++;

        let delay = 0;
        const retryAfter = error.response.headers['retry-after'];

        if (retryAfter && !isNaN(parseInt(String(retryAfter), 10))) {
          // Shopify manda el Retry-After en segundos
          delay = parseInt(String(retryAfter), 10) * 1000;
        } else {
          // Backoff exponencial manual si no hay header: 500ms, 1000ms, 2000ms
          const backoffDelays = [500, 1000, 2000];
          delay = backoffDelays[config.__retryCount - 1];
        }

        console.warn(
          `[Shopify API] 429 Rate Limit en ${normalizedShop}. Reintento ${config.__retryCount}/3 en ${delay}ms...`,
        );

        // Espera no bloqueante
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Re-lanzar la petición original
        return client.request(config);
      },
    );

    return client;
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
   * Obtiene la lista de pedidos normalizados, opcionalmente filtrando por un ID de cliente
   */
  async getOrders(
    userId: string,
    shop: string,
    customerId?: number,
  ): Promise<NormalizedOrdersResponse> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      // Si tenemos customerId, filtramos directamente en la query de Shopify para mayor minimización
      const endpoint = customerId
        ? `/orders.json?customer_id=${customerId}&limit=10`
        : '/orders.json?limit=10';

      const response = await client.get<ShopifyOrdersResponse>(endpoint);
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
  }

  /**
   * Busca un cliente por su número de teléfono.
   * Shopify requiere que el número esté en formato E.164 o similar para ser efectivo.
   */
  async searchCustomerByPhone(
    userId: string,
    shop: string,
    phone: string,
  ): Promise<number | null> {
    try {
      const accessToken = await this.getAccessToken(userId, shop);
      const client = this.createShopifyClient(shop, accessToken);

      // Normalizar el teléfono (eliminar espacios, guiones, etc.)
      const normalizedPhone = phone.replace(/\s|-|\(|\)/g, '').trim();
      if (!normalizedPhone) return null;

      // Shopify permite buscar por teléfono. Probamos con y sin el símbolo '+'
      // En la API de búsqueda de Shopify, se usa query=phone:+34...
      const searchQueries = [
        `phone:${normalizedPhone}`,
        `phone:${normalizedPhone.replace('+', '')}`,
      ];

      for (const query of searchQueries) {
        try {
          const response = await client.get<{
            customers: Array<{ id: number }>;
          }>(`/customers/search.json?query=${encodeURIComponent(query)}`);

          if (response.data.customers && response.data.customers.length > 0) {
            console.log(
              `✅ [Shopify] Cliente encontrado con query "${query}": ${response.data.customers[0].id}`,
            );
            return response.data.customers[0].id;
          }
        } catch (searchError) {
          // Si una búsqueda falla, probamos la siguiente
          console.warn(
            `⚠️ [Shopify] Falló búsqueda con query "${query}":`,
            (searchError as Error).message,
          );
        }
      }

      console.log(
        `ℹ️ [Shopify] No se encontró cliente para el teléfono: ${phone}`,
      );
      return null;
    } catch (error) {
      console.warn(
        `[Shopify] Error buscando cliente por teléfono ${phone}:`,
        (error as Error).message,
      );
      return null;
    }
  }

  /**
   * Registra el webhook de desinstalación en Shopify
   */
  private async registerUninstallWebhook(
    shop: string,
    accessToken: string,
  ): Promise<void> {
    try {
      const baseUrl =
        process.env.NODE_ENV === 'production'
          ? process.env.APP_URL || 'https://llamaloiabackend-5294.onrender.com'
          : process.env.NGROK_URL || 'http://localhost:3000'; // Requiere una URL pública

      const webhookUrl = `${baseUrl}/shopify/webhooks`;

      await axios.post(
        `https://${shop}/admin/api/2026-01/webhooks.json`,
        {
          webhook: {
            topic: 'app/uninstalled',
            address: webhookUrl,
            format: 'json',
          },
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        },
      );

      console.log(`✅ Webhook app/uninstalled registrado en ${shop}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        // Ignorar si el webhook ya existe (Shopify devuelve 422 con un error específico)
        const responseData = error.response.data;
        if (
          error.response.status === 422 &&
          responseData?.errors?.address?.includes('has already been taken')
        ) {
          console.log(
            `ℹ️ Webhook app/uninstalled ya estaba registrado en ${shop}`,
          );
          return;
        }
        console.error(
          `Error al registrar webhook en ${shop}:`,
          JSON.stringify(responseData),
        );
      } else {
        console.error(
          `Error inesperado al registrar webhook en ${shop}:`,
          (error as Error).message,
        );
      }
      throw error;
    }
  }

  /**
   * Verifica de manera atómica si un webhook ya fue procesado.
   * Evita condiciones de carrera en ráfagas de reintentos usando create().
   * Devuelve true si el webhook YA fue procesado, false si es nuevo.
   */
  async verifyWebhookIdempotency(
    webhookId: string,
    topic: string,
    shopDomain: string,
  ): Promise<boolean> {
    if (!webhookId) return false;

    try {
      await this.firestore
        .collection('webhookEvents')
        .doc(webhookId)
        .create({
          topic,
          shopDomain,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          // TTL de 30 días para auto-limpieza
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
      return false; // No existía, seguro para procesar
    } catch (error: any) {
      // El código 6 en Firebase gRPC es ALREADY_EXISTS
      if (error.code === 6) {
        return true; // Ya existe, ignorar
      }
      // Cualquier otro error de Firestore lo loggeamos pero dejamos pasar para no romper el flujo
      console.warn(
        `[Shopify Webhook] Error no crítico verificando idempotencia para ${webhookId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Maneja el webhook de app/uninstalled
   * Se ejecuta cuando el cliente desinstala la aplicación desde el panel de Shopify
   */
  async handleAppUninstalled(shop: string): Promise<void> {
    try {
      const normalizedShop = shop
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');

      console.log(
        `Procesando desinstalación para la tienda: ${normalizedShop}`,
      );

      // Buscar la tienda por dominio (cualquier usuario que la haya conectado)
      const storeQuery = await this.firestore
        .collection('shopifyStores')
        .where('shopDomain', '==', normalizedShop)
        .get();

      if (storeQuery.empty) {
        console.log(
          `Webhook app/uninstalled: No se encontró la tienda ${normalizedShop}`,
        );
        return;
      }

      const now = admin.firestore.Timestamp.now();

      // Procesar cada documento (normalmente habrá uno)
      for (const storeDoc of storeQuery.docs) {
        const storeData = storeDoc.data();
        const ownerUserId = storeData.ownerUserId as string;

        // 1. Revocar la tienda en shopifyStores (y borrar accessToken por seguridad)
        await storeDoc.ref.update({
          status: 'revoked',
          accessToken: admin.firestore.FieldValue.delete(),
          updatedAt: now,
        });

        // 2. Actualizar las integraciones del usuario
        if (ownerUserId) {
          const userDocRef = this.firestore
            .collection('users')
            .doc(ownerUserId);
          const userSnapshot = await userDocRef.get();

          if (userSnapshot.exists) {
            const userData = userSnapshot.data() as Record<string, unknown>;
            const integrations =
              (userData?.integrations as Record<string, unknown>) || {};

            const shopifyArray: Array<{
              connected: boolean;
              shopDomain: string;
            }> = Array.isArray(integrations.shopify)
              ? integrations.shopify
              : [];

            // Filtrar la tienda
            const updatedShopifyArray = shopifyArray.filter(
              (store) => store.shopDomain !== normalizedShop,
            );

            if (updatedShopifyArray.length === 0) {
              // Si no quedan tiendas, eliminar el nodo shopify
              delete integrations.shopify;
              await userDocRef.set({ integrations }, { merge: true });
            } else {
              // Si quedan otras, actualizar el array
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
        }
      }

      console.log(
        `✅ Tienda ${normalizedShop} revocada exitosamente tras desinstalación.`,
      );
    } catch (error) {
      console.error(`Error procesando app/uninstalled para ${shop}:`, error);
      // No relanzamos para que Shopify reciba el 200 OK y no intente reenviar el webhook constantemente si falla nuestra BD
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

      await storeDoc.ref.update({
        status: 'revoked',
        accessToken: admin.firestore.FieldValue.delete(),
        updatedAt: now,
      });

      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (userSnapshot.exists) {
        const userData = userSnapshot.data() as Record<string, unknown>;
        const integrations =
          (userData?.integrations as Record<string, unknown>) || {};

        const shopifyArray: Array<{
          connected: boolean;
          shopDomain: string;
        }> = Array.isArray(integrations.shopify) ? integrations.shopify : [];

        const updatedShopifyArray = shopifyArray.filter(
          (store) => store.shopDomain !== normalizedShop,
        );

        const agentsRaw =
          (userData?.agents as Array<Record<string, unknown>>) || [];
        let agentsChanged = false;
        const updatedAgents = agentsRaw.map((agent) => {
          const raw = agent.shopifyDomain;
          const agentShop =
            typeof raw === 'string'
              ? raw
                  .replace(/^https?:\/\//, '')
                  .replace(/\/$/, '')
                  .toLowerCase()
              : '';
          if (agentShop && agentShop === normalizedShop.toLowerCase()) {
            agentsChanged = true;
            const next = { ...agent };
            delete next.shopifyDomain;
            return next;
          }
          return agent;
        });

        const patch: Record<string, unknown> = {};

        if (updatedShopifyArray.length === 0) {
          delete integrations.shopify;
          patch.integrations = integrations;
        } else {
          patch.integrations = {
            ...integrations,
            shopify: updatedShopifyArray,
          };
        }

        if (agentsChanged) {
          patch.agents = updatedAgents;
        }

        if (Object.keys(patch).length > 0) {
          await userDocRef.set(patch, { merge: true });
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
