import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import {
  OutboundQueueService,
  type OutboundQueueLeadInput,
} from '../agents/outbound-queue.service';
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

/** Pedidos con pago aún no completado (recordatorio de pago vía `orders/create`). */
const ORDER_FINANCIAL_PENDING_REMINDER = new Set([
  'pending',
  'authorized',
  'partially_paid',
  'unpaid',
]);

@Injectable()
export class ShopifyService {
  private readonly firestore = getFirestore();
  private readonly apiVersion = '2026-01';

  constructor(
    private readonly cryptoService: CryptoService,
    @Inject(forwardRef(() => OutboundQueueService))
    private readonly outboundQueueService: OutboundQueueService,
  ) {}

  /**
   * Evita volcar en logs el objeto completo de Axios (ClientRequest, socket, etc.).
   */
  private formatHttpErrorForLog(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const st = err.response?.status;
      let body = '';
      try {
        const data = err.response?.data;
        body =
          typeof data === 'string'
            ? data
            : data != null
              ? JSON.stringify(data)
              : '';
      } catch {
        body = '[cuerpo no serializable]';
      }
      if (body.length > 900) {
        body = `${body.slice(0, 900)}…`;
      }
      return `HTTP ${st ?? '?'} ${err.message} | ${body}`;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  /**
   * 422 cuando la misma URL ya está registrada para ese topic en Shopify.
   * Nota: `errors.address` es un array de strings; hay que comprobar cada elemento.
   */
  private isWebhookAddressAlreadyTaken(
    status: number,
    responseData: unknown,
  ): boolean {
    if (status !== 422) {
      return false;
    }
    const errors = (responseData as { errors?: { address?: unknown } } | null)
      ?.errors;
    const addr = errors?.address;
    const matches = (text: string) =>
      text.toLowerCase().includes('already been taken');
    if (Array.isArray(addr)) {
      return addr.some((msg) => matches(String(msg)));
    }
    if (typeof addr === 'string') {
      return matches(addr);
    }
    return false;
  }

  /**
   * URL base pública del API (OAuth `redirect_uri`, webhooks). Prioriza `APP_URL` siempre que esté definida,
   * con o sin NODE_ENV=production (cada despliegue Render dev/preprod/prod debe tener su `APP_URL`).
   * Debe coincidir carácter a carácter con "Allowed redirection URL(s)" en Shopify Partners.
   */
  getPublicApiBaseUrl(): string {
    const explicit = process.env.APP_URL?.trim();
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }
    if (process.env.NODE_ENV === 'production') {
      return 'https://llamaloiabackend-5294.onrender.com';
    }
    const devTunnel = (process.env.NGROK_URL || 'http://localhost:3000').trim();
    return devTunnel.replace(/\/$/, '');
  }

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
            this.formatHttpErrorForLog(err),
          );
        },
      );
      this.registerCheckoutEnqueueWebhook(normalizedShop, accessToken).catch(
        (err) => {
          console.error(
            `Error al registrar webhook checkouts/update para ${normalizedShop}:`,
            this.formatHttpErrorForLog(err),
          );
        },
      );
      this.registerOrdersOutboundWebhooks(normalizedShop, accessToken).catch(
        (err) => {
          console.error(
            `Error al registrar webhooks orders/paid u orders/create para ${normalizedShop}:`,
            this.formatHttpErrorForLog(err),
          );
        },
      );

      /** Histórico de pedidos → cola outbound (no solo webhooks en tiempo real). */
      void this.syncHistoricalOrdersToOutboundQueue(userId, normalizedShop, {
        sinceDays: 365,
        maxOrders: 3000,
      }).catch((err) => {
        console.error(
          `[Shopify outbound] sync histórico post-OAuth ${normalizedShop}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
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
      const baseUrl = this.getPublicApiBaseUrl();
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
        const responseData = error.response.data;
        if (
          this.isWebhookAddressAlreadyTaken(
            error.response.status,
            responseData,
          )
        ) {
          console.log(
            `ℹ️ Webhook app/uninstalled ya estaba registrado en ${shop}`,
          );
          return;
        }
      }
      throw error;
    }
  }

  /** Registra un webhook REST Admin en la misma URL que el resto de topics. */
  private async registerShopifyTopicWebhook(
    shop: string,
    accessToken: string,
    topic: string,
  ): Promise<void> {
    try {
      const baseUrl = this.getPublicApiBaseUrl();
      const webhookUrl = `${baseUrl}/shopify/webhooks`;

      await axios.post(
        `https://${shop}/admin/api/2026-01/webhooks.json`,
        {
          webhook: {
            topic,
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

      console.log(`✅ Webhook ${topic} registrado en ${shop}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const responseData = error.response.data;
        if (
          this.isWebhookAddressAlreadyTaken(
            error.response.status,
            responseData,
          )
        ) {
          console.log(`ℹ️ Webhook ${topic} ya estaba registrado en ${shop}`);
          return;
        }
      }
      throw error;
    }
  }

  private async registerCheckoutEnqueueWebhook(
    shop: string,
    accessToken: string,
  ): Promise<void> {
    await this.registerShopifyTopicWebhook(shop, accessToken, 'checkouts/update');
  }

  /** Encuesta post-compra, ofertas post-compra y recordatorios (pedidos sin pagar). */
  private async registerOrdersOutboundWebhooks(
    shop: string,
    accessToken: string,
  ): Promise<void> {
    await Promise.all([
      this.registerShopifyTopicWebhook(shop, accessToken, 'orders/paid'),
      this.registerShopifyTopicWebhook(shop, accessToken, 'orders/create'),
    ]);
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
  static normalizeWebhookShopDomain(domain: string): string {
    const trimmed = domain.trim();
    if (!trimmed) return '';
    return trimmed
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .replace(/\.+$/, '')
      .toLowerCase();
  }

  /** Solo para logs: no exponer el número completo. */
  private maskPhoneForLog(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length <= 2) return '****';
    return `…${digits.slice(-4)}`;
  }

  private extractCheckoutPhone(
    checkout: Record<string, unknown>,
  ): {
    phone: string | undefined;
    source: 'checkout' | 'shipping' | 'billing' | 'none';
  } {
    const ship = checkout.shipping_address as
      | Record<string, unknown>
      | undefined;
    const bill = checkout.billing_address as
      | Record<string, unknown>
      | undefined;
    if (ship) {
      const p = ship.phone;
      if (typeof p === 'string' && p.trim()) {
        return { phone: p.trim(), source: 'shipping' };
      }
    }
    if (bill) {
      const p = bill.phone;
      if (typeof p === 'string' && p.trim()) {
        return { phone: p.trim(), source: 'billing' };
      }
    }
    const top = checkout.phone;
    if (typeof top === 'string' && top.trim()) {
      return { phone: top.trim(), source: 'checkout' };
    }
    return { phone: undefined, source: 'none' };
  }

  /** Quita comillas simples típicas de exportes CSV de Shopify. */
  private normalizePhoneRaw(raw: string): string {
    return raw
      .trim()
      .replace(/^['\u2019]+\s*/, '')
      .replace(/\s*['\u2019]+$/, '')
      .trim();
  }

  private pickPhoneString(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const t = this.normalizePhoneRaw(v);
    return t || undefined;
  }

  /**
   * Teléfono del pedido: envío, facturación, raíz, cliente o dirección por defecto del cliente.
   * Los webhooks a veces envían un cuerpo reducido sin direcciones; entonces hace falta GET /orders/:id.
   */
  private extractOrderPhone(order: Record<string, unknown>): {
    phone: string | undefined;
    source: string;
  } {
    // Prioridad alineada con integraciones típicas (envío suele llevar el móvil de contacto).
    const ship = order.shipping_address as
      | Record<string, unknown>
      | undefined;
    const bill = order.billing_address as
      | Record<string, unknown>
      | undefined;
    if (ship) {
      const p = this.pickPhoneString(ship.phone);
      if (p) {
        return { phone: p, source: 'shipping' };
      }
    }
    if (bill) {
      const p = this.pickPhoneString(bill.phone);
      if (p) {
        return { phone: p, source: 'billing' };
      }
    }
    const top = this.pickPhoneString(order.phone);
    if (top) {
      return { phone: top, source: 'order' };
    }
    const customer = order.customer as Record<string, unknown> | undefined;
    if (customer) {
      const cp = this.pickPhoneString(customer.phone);
      if (cp) {
        return { phone: cp, source: 'customer' };
      }
      const def = customer.default_address as
        | Record<string, unknown>
        | undefined;
      const dp = this.pickPhoneString(def?.phone);
      if (dp) {
        return { phone: dp, source: 'customer_default_address' };
      }
    }
    return { phone: undefined, source: 'none' };
  }

  /** Pedido completo REST (útil cuando el webhook o el listado vienen sin teléfono). */
  private async fetchShopifyOrderById(
    normalizedShop: string,
    orderId: string,
  ): Promise<Record<string, unknown> | null> {
    const storesSnap = await this.firestore
      .collection('shopifyStores')
      .where('shopDomain', '==', normalizedShop)
      .limit(1)
      .get();
    if (storesSnap.empty) {
      return null;
    }
    const ownerUserId = storesSnap.docs[0].data()?.ownerUserId as
      | string
      | undefined;
    if (!ownerUserId) {
      return null;
    }
    try {
      const token = await this.getAccessToken(ownerUserId, normalizedShop);
      const client = this.createShopifyClient(normalizedShop, token);
      const res = await client.get<{ order?: Record<string, unknown> }>(
        `/orders/${encodeURIComponent(orderId)}.json`,
      );
      return (res.data.order as Record<string, unknown>) ?? null;
    } catch (e) {
      console.warn(
        `[Shopify outbound] No se pudo cargar pedido ${orderId} en ${normalizedShop}:`,
        this.formatHttpErrorForLog(e),
      );
      return null;
    }
  }

  /**
   * Si el payload no trae teléfono, intenta GET /orders/:id.json y fusiona campos.
   */
  private async resolveOrderPayloadWithPhoneFallback(
    normalizedShop: string,
    order: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.extractOrderPhone(order).phone) {
      return order;
    }
    const idRaw = order.id;
    if (idRaw == null || String(idRaw).trim() === '') {
      return order;
    }
    const full = await this.fetchShopifyOrderById(
      normalizedShop,
      String(idRaw),
    );
    if (!full) {
      return order;
    }
    const merged = { ...order, ...full } as Record<string, unknown>;
    if (!this.extractOrderPhone(merged).phone) {
      console.log(
        `[Shopify outbound] Pedido ${idRaw}: payload ampliado sin teléfono (revisar datos protegidos de cliente en Partners / consentimientos de la tienda).`,
      );
    }
    return merged;
  }

  /**
   * Construye fila de cola desde payload REST Order de webhook.
   * @param eventAtPreference processed = pagos (`orders/paid`); created = alta del pedido (`orders/create`).
   */
  private buildOutboundLeadFromOrder(
    order: Record<string, unknown>,
    eventAtPreference: 'processed' | 'created',
  ): OutboundQueueLeadInput | null {
    const extracted = this.extractOrderPhone(order);
    if (!extracted.phone?.trim()) {
      return null;
    }

    const orderId = order.id;
    const externalEventId =
      orderId != null && String(orderId).trim() !== ''
        ? `order_${String(orderId)}`
        : undefined;

    let eventAtIso: string;
    if (eventAtPreference === 'processed') {
      const p = order.processed_at;
      const c = order.created_at;
      const u = order.updated_at;
      eventAtIso =
        (typeof p === 'string' && p) ||
        (typeof c === 'string' && c) ||
        (typeof u === 'string' && u) ||
        new Date().toISOString();
    } else {
      const c = order.created_at;
      eventAtIso =
        (typeof c === 'string' && c) || new Date().toISOString();
    }

    const tp = order.total_price ?? order.subtotal_price;
    let cartTotal: number | undefined;
    if (typeof tp === 'string' || typeof tp === 'number') {
      const n = parseFloat(String(tp));
      if (Number.isFinite(n)) cartTotal = n;
    }

    const lineItems = order.line_items as
      | Array<Record<string, unknown>>
      | undefined;
    const cartItemCount = Array.isArray(lineItems)
      ? lineItems.length
      : undefined;

    let productHandle: string | undefined;
    if (lineItems?.length) {
      const first = lineItems[0];
      if (typeof first?.sku === 'string' && first.sku.trim()) {
        productHandle = first.sku.trim();
      } else if (typeof first?.vendor === 'string' && first.vendor.trim()) {
        productHandle = first.vendor.trim();
      } else if (
        first?.variant_id !== undefined &&
        first?.variant_id !== null
      ) {
        productHandle = String(first.variant_id);
      }
    }

    const customer = order.customer as Record<string, unknown> | undefined;
    let customerState: 'new' | 'recurring' | null = null;
    if (customer && typeof customer.orders_count === 'number') {
      customerState =
        customer.orders_count <= 1 ? 'new' : 'recurring';
    }

    return {
      phone: extracted.phone,
      eventAt: eventAtIso,
      externalEventId: externalEventId ?? null,
      contactTicket: cartTotal !== undefined ? cartTotal : null,
      customerState,
      cartTotal: cartTotal !== undefined ? cartTotal : null,
      cartItemCount: cartItemCount !== undefined ? cartItemCount : null,
      productHandle: productHandle ?? null,
    };
  }

  /**
   * Encola `lead` para agentes outbound de la tienda con `shopifyDomain` coincidente
   * y tipo de campaña incluido en `campaignKinds`.
   */
  private async enqueueShopifyOutboundForCampaignKinds(
    normalizedShop: string,
    campaignKinds: Set<string>,
    lead: OutboundQueueLeadInput,
  ): Promise<number> {
    const storesSnap = await this.firestore
      .collection('shopifyStores')
      .where('shopDomain', '==', normalizedShop)
      .limit(40)
      .get();

    let enqueueCalls = 0;

    for (const sdoc of storesSnap.docs) {
      const ownerUserId = sdoc.data()?.ownerUserId as string | undefined;
      if (!ownerUserId) continue;

      const userSnap = await this.firestore
        .collection('users')
        .doc(ownerUserId)
        .get();
      if (!userSnap.exists) continue;
      const userData = userSnap.data() as Record<string, unknown>;
      const agents =
        (userData.agents as Array<Record<string, unknown>>) || [];

      for (const agent of agents) {
        if (agent.type !== 'outbound') continue;
        const kind = String(agent.outboundCampaignKind ?? '');
        if (!campaignKinds.has(kind)) continue;

        const rawDom = agent.shopifyDomain as string | undefined;
        const agentShop = rawDom
          ? ShopifyService.normalizeWebhookShopDomain(rawDom)
          : '';
        if (!agentShop || agentShop !== normalizedShop) continue;

        const agentId = Number(agent.agentId ?? 0);
        if (!agentId) continue;

        await this.outboundQueueService.syncQueue(
          ownerUserId,
          agentId,
          [],
          [lead],
          {
            outboundCampaignKind: agent.outboundCampaignKind as
              | string
              | undefined,
            outboundScheduleCampaignNotes:
              agent.outboundScheduleCampaignNotes as string | undefined,
            outboundSegmentationNotes:
              agent.outboundSegmentationNotes as string | undefined,
          },
          'shopify',
        );
        enqueueCalls++;
      }
    }

    return enqueueCalls;
  }

  /** `orders/paid` → encuesta de satisfacción y ofertas post-compra. */
  async handleOrdersPaidOutboundWebhook(
    shopDomainHeader: string,
    orderPayload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const normalizedShop =
        ShopifyService.normalizeWebhookShopDomain(shopDomainHeader);
      if (!normalizedShop) {
        console.log(
          '[Shopify outbound] orders/paid: dominio de tienda inválido; se ignora.',
        );
        return;
      }

      const merged = await this.resolveOrderPayloadWithPhoneFallback(
        normalizedShop,
        orderPayload,
      );
      const phoneMeta = this.extractOrderPhone(merged);
      const lead = this.buildOutboundLeadFromOrder(merged, 'processed');
      if (!lead) {
        const oid = String(merged.id ?? '').slice(0, 12);
        console.log(
          `[Shopify outbound] orders/paid: sin teléfono tras webhook+GET pedido (shop=${normalizedShop}, order~=${oid || 'n/a'}, últimaFuente=${phoneMeta.source}).`,
        );
        return;
      }

      console.log(
        `[Shopify outbound] orders/paid: teléfono OK (shop=${normalizedShop}, origen=${phoneMeta.source}, número=${this.maskPhoneForLog(lead.phone)})`,
      );

      const n = await this.enqueueShopifyOutboundForCampaignKinds(
        normalizedShop,
        new Set(['satisfactionSurvey', 'postPurchase']),
        lead,
      );
      if (n === 0) {
        console.log(
          `[Shopify outbound] orders/paid: ningún agente satisfactionSurvey/postPurchase para shop=${normalizedShop}.`,
        );
      }
    } catch (e) {
      console.error('[Shopify outbound] orders/paid:', e);
    }
  }

  /**
   * `orders/create` con pago pendiente → recordatorio de pago.
   * Pedidos ya pagados se ignoran aquí (entran por `orders/paid`).
   */
  async handleOrdersCreateOutboundWebhook(
    shopDomainHeader: string,
    orderPayload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const normalizedShop =
        ShopifyService.normalizeWebhookShopDomain(shopDomainHeader);
      if (!normalizedShop) {
        return;
      }

      const financial = String(
        orderPayload.financial_status ?? '',
      ).toLowerCase();
      if (!financial || !ORDER_FINANCIAL_PENDING_REMINDER.has(financial)) {
        return;
      }

      const merged = await this.resolveOrderPayloadWithPhoneFallback(
        normalizedShop,
        orderPayload,
      );
      const phoneMeta = this.extractOrderPhone(merged);
      const lead = this.buildOutboundLeadFromOrder(merged, 'created');
      if (!lead) {
        const oid = String(merged.id ?? '').slice(0, 12);
        console.log(
          `[Shopify outbound] orders/create: sin teléfono tras webhook+GET (shop=${normalizedShop}, order~=${oid || 'n/a'}, financial=${financial}, últimaFuente=${phoneMeta.source}).`,
        );
        return;
      }

      console.log(
        `[Shopify outbound] orders/create (pendiente): teléfono OK (shop=${normalizedShop}, financial=${financial}, origen=${phoneMeta.source}, número=${this.maskPhoneForLog(lead.phone)})`,
      );

      const n = await this.enqueueShopifyOutboundForCampaignKinds(
        normalizedShop,
        new Set(['paymentReminder']),
        lead,
      );
      if (n === 0) {
        console.log(
          `[Shopify outbound] orders/create: ningún agente paymentReminder para shop=${normalizedShop}.`,
        );
      }
    } catch (e) {
      console.error('[Shopify outbound] orders/create:', e);
    }
  }

  /**
   * Lista pedidos vía REST Admin (paginado) desde `created_at_min` y encola outbound
   * igual que los webhooks: pagados → encuesta/post-compra; pendientes de pago → recordatorio.
   * Sirve para **histórico** (p. ej. clientes que compraron hace semanas): los webhooks solo cubren eventos nuevos.
   */
  async syncHistoricalOrdersToOutboundQueue(
    userId: string,
    shop: string,
    opts: { sinceDays?: number; maxOrders?: number } = {},
  ): Promise<{
    shop: string;
    sinceDays: number;
    maxOrders: number;
    scanned: number;
    enqueuedPaidAgentCalls: number;
    enqueuedPendingAgentCalls: number;
    skippedNoPhone: number;
    skippedFinancialOther: number;
  }> {
    const sinceDays = Math.min(Math.max(opts.sinceDays ?? 365, 1), 730);
    const maxOrders = Math.min(Math.max(opts.maxOrders ?? 5000, 1), 25000);

    const normalizedShop = ShopifyService.normalizeWebhookShopDomain(
      shop.replace(/^https?:\/\//i, ''),
    );
    if (!normalizedShop) {
      throw new BadRequestException('Dominio de tienda inválido.');
    }

    const accessToken = await this.getAccessToken(userId, normalizedShop);
    const client = this.createShopifyClient(normalizedShop, accessToken);

    const createdAtMin = new Date(
      Date.now() - sinceDays * 86400000,
    ).toISOString();

    let scanned = 0;
    let enqueuedPaidAgentCalls = 0;
    let enqueuedPendingAgentCalls = 0;
    let skippedNoPhone = 0;
    let skippedFinancialOther = 0;
    let sinceId: number | undefined;

    console.log(
      `[Shopify outbound] sync histórico: inicio shop=${normalizedShop}, sinceDays=${sinceDays}, maxOrders=${maxOrders}, created_at_min=${createdAtMin}`,
    );

    try {
      while (scanned < maxOrders) {
        const limit = 250;
        let path = `/orders.json?limit=${limit}&status=any&created_at_min=${encodeURIComponent(createdAtMin)}&order=id+asc`;
        if (sinceId !== undefined) {
          path += `&since_id=${sinceId}`;
        }

        const response = await client.get<{ orders?: Array<Record<string, unknown>> }>(
          path,
        );
        const orders = response.data.orders ?? [];
        if (orders.length === 0) {
          break;
        }

        for (const order of orders) {
          if (scanned >= maxOrders) {
            break;
          }
          scanned++;

          const merged = await this.resolveOrderPayloadWithPhoneFallback(
            normalizedShop,
            order,
          );
          const financial = String(merged.financial_status ?? '').toLowerCase();

          if (financial === 'paid') {
            const lead = this.buildOutboundLeadFromOrder(merged, 'processed');
            if (!lead) {
              skippedNoPhone++;
              continue;
            }
            enqueuedPaidAgentCalls +=
              await this.enqueueShopifyOutboundForCampaignKinds(
                normalizedShop,
                new Set(['satisfactionSurvey', 'postPurchase']),
                lead,
              );
          } else if (ORDER_FINANCIAL_PENDING_REMINDER.has(financial)) {
            const lead = this.buildOutboundLeadFromOrder(merged, 'created');
            if (!lead) {
              skippedNoPhone++;
              continue;
            }
            enqueuedPendingAgentCalls +=
              await this.enqueueShopifyOutboundForCampaignKinds(
                normalizedShop,
                new Set(['paymentReminder']),
                lead,
              );
          } else {
            skippedFinancialOther++;
          }
        }

        const last = orders[orders.length - 1];
        const lastId = Number(last?.id ?? 0);
        if (!Number.isFinite(lastId) || lastId <= 0) {
          break;
        }
        sinceId = lastId;

        if (orders.length < limit) {
          break;
        }

        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        throw new BadRequestException(
          `Error al listar pedidos en Shopify: ${this.formatHttpErrorForLog(e)}`,
        );
      }
      throw e;
    }

    const summary = {
      shop: normalizedShop,
      sinceDays,
      maxOrders,
      scanned,
      enqueuedPaidAgentCalls,
      enqueuedPendingAgentCalls,
      skippedNoPhone,
      skippedFinancialOther,
    };
    console.log(
      `[Shopify outbound] sync histórico: fin shop=${normalizedShop}`,
      summary,
    );
    return summary;
  }

  /** Usa topic `checkouts/update` como señal de abandono cuando el checkout sigue abierto y hay teléfono. */
  async handleOutboundCheckoutWebhook(
    shopDomainHeader: string,
    checkoutPayload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const normalizedShop =
        ShopifyService.normalizeWebhookShopDomain(shopDomainHeader);
      if (!normalizedShop) {
        console.log(
          '[Shopify outbound] checkouts/update: dominio de tienda vacío o inválido; se ignora.',
        );
        return;
      }

      const completedRaw = checkoutPayload.completed_at;
      if (
        completedRaw !== null &&
        completedRaw !== undefined &&
        String(completedRaw).trim() !== ''
      ) {
        console.log(
          `[Shopify outbound] checkouts/update: checkout completado (shop=${normalizedShop}); no se trata como abandono.`,
        );
        return;
      }

      const checkoutTokenHint = String(
        checkoutPayload.token ??
          checkoutPayload.id ??
          checkoutPayload.checkout_id ??
          '',
      ).slice(0, 20);

      const extracted = this.extractCheckoutPhone(checkoutPayload);
      const phoneRaw = extracted.phone;
      if (!phoneRaw?.trim()) {
        const ship = checkoutPayload.shipping_address as
          | Record<string, unknown>
          | undefined;
        const bill = checkoutPayload.billing_address as
          | Record<string, unknown>
          | undefined;
        console.log(
          `[Shopify outbound] checkouts/update: sin teléfono en payload (shop=${normalizedShop}, token~=${checkoutTokenHint || 'n/a'}).`,
          {
            hasCheckoutRootPhone:
              typeof checkoutPayload.phone === 'string' &&
              !!checkoutPayload.phone.trim(),
            hasShippingPhone:
              typeof ship?.phone === 'string' && !!String(ship.phone).trim(),
            hasBillingPhone:
              typeof bill?.phone === 'string' && !!String(bill.phone).trim(),
          },
        );
        return;
      }

      console.log(
        `[Shopify outbound] checkouts/update: teléfono obtenido correctamente (shop=${normalizedShop}, origen=${extracted.source}, número=${this.maskPhoneForLog(phoneRaw)})`,
      );

      const externalEventId =
        String(
          checkoutPayload.token ??
            checkoutPayload.id ??
            checkoutPayload.checkout_id ??
            '',
        ).trim() || undefined;

      const eventAtIso =
        (typeof checkoutPayload.updated_at === 'string' &&
          checkoutPayload.updated_at) ||
        (typeof checkoutPayload.created_at === 'string' &&
          checkoutPayload.created_at) ||
        new Date().toISOString();

      let cartTotal: number | undefined;
      const tp = checkoutPayload.total_price ?? checkoutPayload.subtotal_price;
      if (typeof tp === 'string' || typeof tp === 'number') {
        const n = parseFloat(String(tp));
        if (Number.isFinite(n)) cartTotal = n;
      }

      const lineItems = checkoutPayload.line_items as
        | Array<Record<string, unknown>>
        | undefined;
      const cartItemCount = Array.isArray(lineItems)
        ? lineItems.length
        : undefined;

      let productHandle: string | undefined;
      if (lineItems?.length) {
        const sku =
          typeof lineItems[0]?.sku === 'string'
            ? lineItems[0].sku
            : typeof lineItems[0]?.vendor === 'string'
              ? (lineItems[0].vendor as string)
              : undefined;
        if (sku?.trim()) productHandle = sku.trim();
      }

      const lead: OutboundQueueLeadInput = {
        phone: phoneRaw,
        eventAt: eventAtIso,
        externalEventId: externalEventId ?? null,
        contactTicket: cartTotal !== undefined ? cartTotal : null,
        customerState: null,
        cartTotal: cartTotal !== undefined ? cartTotal : null,
        cartItemCount: cartItemCount !== undefined ? cartItemCount : null,
        productHandle: productHandle ?? null,
      };

      const abandonedCartEnqueueCalls =
        await this.enqueueShopifyOutboundForCampaignKinds(
          normalizedShop,
          new Set(['abandonedCart']),
          lead,
        );

      if (abandonedCartEnqueueCalls === 0) {
        console.log(
          `[Shopify outbound] checkouts/update: teléfono obtenido pero no se llamó a la cola (shop=${normalizedShop}). Revisa agente outbound abandonedCart y shopifyDomain.`,
        );
      }
    } catch (e) {
      console.error('[Shopify outbound] checkout webhook:', e);
    }
  }

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
