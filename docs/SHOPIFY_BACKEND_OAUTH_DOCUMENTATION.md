# Documentación técnica backend: integración OAuth y SaaS ↔ Shopify

Este documento responde punto por punto las preguntas del equipo para validar que la integración está correctamente implementada y lista para producción, con detalle técnico (no genérico).

---

## 🔐 OAuth y seguridad

### 1️⃣ Endpoint de inicio OAuth

**¿Qué hace exactamente GET /shopify/auth?**

- **Ruta:** `GET /shopify/auth` (controller: `ShopifyController.auth`, línea 91).
- **Protegido:** Requiere `FirebaseAuthGuard` y Bearer token (Firebase).
- **Query obligatorio:** `shop` (dominio de la tienda, ej. `llamaloai-dev.myshopify.com`).
- **Query opcionales:** `returnTo` (URL absoluta del frontend para redirigir tras el callback), `redirect` (si es `false` o la petición viene de Swagger, devuelve JSON con `authUrl` en lugar de redirigir).
- **Comportamiento:**
  1. Crea una sesión OAuth en Firestore (`createOAuthSession`) con `userId` (del token Firebase), `shopDomain` normalizado y opcionalmente `frontendRedirectUrl` (= `returnTo`).
  2. Construye `redirect_uri` como `{APP_URL}/shopify/callback` (en producción usa `process.env.APP_URL` o fallback a Render).
  3. Genera la URL de autorización de Shopify con `getAuthUrl(shop, redirectUri, oauthSessionId)` y redirige (302) a esa URL, o devuelve JSON con `authUrl` si es Swagger o `redirect=false`.

**¿Genera state dinámico?**

- **Sí.** El `state` es un **oauthSessionId** generado con `crypto.randomBytes(32).toString('hex')` (64 caracteres hex). No es un valor fijo ni predecible.

**¿Dónde se almacena ese state para validarlo luego?**

- En la colección de Firestore **`oauthSessions`**, documento con ID = `sessionId` (el mismo valor que se envía como `state`). Cada documento contiene: `id`, `userId`, `shopDomain`, `frontendRedirectUrl` (opcional), `createdAt`, `expiresAt` (10 minutos). Se elimina tras un uso correcto en el callback (`deleteOAuthSession`).

---

### 2️⃣ Callback

**Ruta exacta del callback**

- **GET** `{BASE_URL}/shopify/callback`.  
  Ejemplo: `https://llamaloiabackend-5294.onrender.com/shopify/callback` en producción, `http://localhost:3000/shopify/callback` en local.  
  Definido en el controller como `@Get('callback')` en el mismo `@Controller('shopify')`.

**¿Validamos state?**

- **Sí.** Se exige que venga el query param `state`. Se llama a `validateOAuthSession(query.state)`, que:
  - Comprueba que exista el documento en `oauthSessions` con ese ID.
  - Comprueba que no esté expirado (`expiresAt > now`); si está expirado se borra el documento y se lanza `UnauthorizedException`.
  - Devuelve los datos de la sesión (incl. `userId`, `shopDomain`, `frontendRedirectUrl`).
- Además se verifica que el `shop` recibido en el callback (normalizado) coincida con `oauthSession.shopDomain`; si no, 400 y redirección a frontend con error si hay `returnTo`.

**¿Validamos HMAC firmado por Shopify?**

- **No.** En el código actual **no se valida el parámetro `hmac`** que Shopify envía en el callback. El DTO `ShopifyCallbackQueryDto` solo incluye `shop`, `code` y `state`.  
  **Recomendación:** Añadir validación HMAC según la documentación de Shopify (firmar con `SHOPIFY_API_SECRET` la query string ordenada y comparar con el `hmac` recibido) para cumplir buenas prácticas y asegurar que el callback proviene de Shopify.

**¿Qué ocurre si falla la validación?**

- Si falta `state`: se redirige al frontend con `?shopify=error&code=400&message=state requerido` (si hay `redirectBase`) o se lanza `BadRequestException`.
- Si la sesión no existe o está expirada: `UnauthorizedException`; si hay `redirectBase`, redirección con `shopify=error&code=401&message=...`.
- Si el dominio no coincide: redirección con `shopify=error&code=400&message=dominio no coincide con la sesión` o `BadRequestException`.
- Cualquier otro error en el callback (p. ej. intercambio de código): redirección con `shopify=error&code=400|401&message=...` (mensaje truncado a 200 caracteres) o re-lanzado como `BadRequestException`/`UnauthorizedException`.

---

### 3️⃣ Intercambio de code → access_token

**Endpoint usado (confirmar formato)**

- **POST** `https://{normalizedShop}/admin/oauth/access_token`.  
  Body JSON: `{ client_id, client_secret, code }`.  
  `client_id` = `process.env.SHOPIFY_API_KEY`, `client_secret` = `process.env.SHOPIFY_API_SECRET`.  
  Implementado en `ShopifyService.exchangeCodeForToken` (shopify.service.ts).

**API version usada**

- La versión de API de Shopify usada en las llamadas **REST posteriores** (shop, products, orders) es **`2026-01`** (propiedad `apiVersion` en `ShopifyService`).  
  El endpoint de token OAuth **no lleva** versión en la URL; es el estándar de OAuth de Shopify.

**¿Guardamos también el scope devuelto por Shopify?**

- **Sí.** La respuesta de Shopify incluye `access_token` y `scope` (string). En `saveAccessToken` se recibe `tokenResponse.scope`, se convierte a array con `scopes.split(',').map(s => s.trim())` y se persiste en el documento de la tienda como **`scopes`** (array).

**¿Manejamos errores de intercambio?**

- **Sí.** En `exchangeCodeForToken`, si axios devuelve 401 o 403 se lanza `UnauthorizedException('Código de autorización inválido o expirado')`. Para otros errores de respuesta se lanza `BadRequestException` con el mensaje de Shopify o el mensaje de error. Cualquier otro error se lanza como `InternalServerErrorException`. Estos errores se traducen en el callback a redirección con `shopify=error` o a la excepción HTTP correspondiente.

---

## 🗄 Persistencia y modelo de datos

### 4️⃣ ¿Existe tabla/colección Shops? Estructura exacta

- **Sí.** Se usa la colección de Firestore **`shopifyStores`** (no hay tabla SQL). No hay campo `installed_at` con ese nombre; las fechas son `createdAt` y `updatedAt`.

**Estructura de cada documento:**

| Campo         | Tipo     | Descripción |
|---------------|----------|-------------|
| `id`          | string   | ID del documento Firestore (generado con `doc()`) |
| `shopDomain` | string   | Dominio normalizado (sin protocolo ni trailing slash) |
| `shopName`    | string   | Nombre de la tienda (desde Shopify API o dominio como fallback) |
| `accessToken`| string   | Token de acceso de Shopify (actualmente **en claro**, no encriptado) |
| `scopes`     | string[] | Scopes concedidos (array obtenido del `scope` devuelto por Shopify) |
| `ownerUserId`| string   | UID del usuario Firebase propietario |
| `status`     | 'active' \| 'revoked' | Estado de la conexión |
| `createdAt`  | Timestamp | Creación del documento |
| `updatedAt`  | Timestamp | Última actualización |

**¿Encriptado el access_token?**

- **No.** Se almacena en texto plano en el documento. El README del módulo indica que en producción se puede encriptar antes de guardar; actualmente no está implementado.

---

### 5️⃣ ¿Un usuario puede tener múltiples tiendas?

- **Sí.** La relación es **multi-tenant**: un usuario puede tener varias tiendas.

**Modelado:**

- **shopifyStores:** Varios documentos pueden tener el mismo `ownerUserId` y distintos `shopDomain`. La relación es N tiendas por usuario (consultas con `where('ownerUserId', '==', userId)` y `where('status', '==', 'active')` donde aplica).
- **users:** En el documento del usuario, `integrations.shopify` es un **array** de objetos `{ connected: boolean, shopDomain: string }`. Cada entrada es una tienda conectada. Al conectar/actualizar una tienda se hace push o actualización en ese array; al revocar se filtra por `shopDomain`.

Por tanto es **multi-tenant real**: un usuario puede tener N tiendas; cada request del agente identifica la tienda por `shopDomain` (ver punto 13).

---

### 6️⃣ ¿Qué ocurre si el mismo usuario conecta dos veces la misma tienda?

- **Actualización (upsert), no duplicado.** En `saveAccessToken`:
  1. Se busca un documento en `shopifyStores` con `shopDomain === normalizedShop` y `ownerUserId === userId` (`limit(1)`).
  2. Si existe: se hace **update** de ese documento con `shopName`, `accessToken`, `scopes`, `status: 'active'`, `updatedAt`.
  3. Si no existe: se crea un **nuevo** documento con todos los campos.
  4. En `users`, el array `integrations.shopify` se actualiza para que esa tienda aparezca una sola vez con `connected: true` (se busca por `shopDomain` y se reemplaza o se añade).

Resultado: una sola fila lógica por (usuario, tienda); reconectar la misma tienda refresca token y scopes.

---

## 🔔 Webhooks (CRÍTICO)

### 7️⃣ ¿Registramos app/uninstalled automáticamente tras OAuth?

- **No.** Tras el flujo OAuth **no** se registra ningún webhook. No hay llamada a la API de Shopify para crear el webhook `app/uninstalled` (ni ningún otro) después de guardar el token.  
  Por tanto, si el merchant desinstala la app desde el admin de Shopify, el backend **no** recibe notificación y el token y los datos asociados **siguen** en `shopifyStores` y en `users.integrations.shopify` hasta que el usuario revoque manualmente o se implemente el webhook.

**¿Dónde se registraría?**

- Lo habitual sería, tras `saveAccessToken` (o en un paso posterior), llamar a la API de Shopify para registrar el webhook (p. ej. `POST /admin/api/2026-01/webhooks.json` con `topic: "app/uninstalled"`). Eso **no está implementado**.

**Validación HMAC de webhooks / eliminación de datos**

- Al no existir endpoint de webhooks, **no** hay validación HMAC de webhooks ni lógica que elimine/revoque token y datos al recibir `app/uninstalled`.  
  **Recomendación:** Implementar un endpoint POST que reciba webhooks de Shopify, verifique HMAC (header `X-Shopify-Hmac-Sha256`), y para `app/uninstalled` actualice la tienda a `status: 'revoked'` (o borre) y actualice `users.integrations.shopify`.

---

### 8️⃣ ¿Tenemos otros webhooks activos?

- **No.** No hay registro ni manejo de webhooks como `orders/create`, `orders/updated`, `products/update`, etc. Toda la información de pedidos y productos se obtiene **on-demand** vía API REST (GET) cuando el agente o el frontend lo solicitan.

---

### 9️⃣ ¿Hay reintentos o manejo de fallos en webhooks?

- **N/A:** al no haber webhooks implementados, no hay reintentos ni manejo de fallos específico para webhooks. Cuando se implementen, convendría idempotencia por `X-Shopify-Webhook-Id` y respuestas 2xx para evitar reintentos innecesarios de Shopify.

---

## 📊 Consumo de datos Shopify

### 10️⃣ ¿Ya estamos consumiendo API?

- **Sí.** Se consumen endpoints REST de Shopify usando la versión **2026-01** y el token por tienda.

**Pedidos**

- **Endpoint:** `GET https://{shop}/admin/api/2026-01/orders.json` (sin filtros de límite en la implementación actual; Shopify devuelve por defecto un conjunto limitado).  
  Uso: `ShopifyService.getOrders(userId, shop)` → `createShopifyClient` + `client.get<ShopifyOrdersResponse>('/orders.json')`.  
  Los pedidos se normalizan a `NormalizedOrder` (orderId, orderName, status, fulfillmentStatus, totalPrice, currency, createdAt, updatedAt, customer, lineItems).

**Productos**

- **Endpoint:** `GET https://{shop}/admin/api/2026-01/products.json`.  
  Uso: `ShopifyService.getProducts(userId, shop)`.  
  Respuesta normalizada a `NormalizedProduct` (incl. variants e images).

**Fulfillments**

- No se llama a un endpoint específico de fulfillments (p. ej. `orders/{id}/fulfillments.json`). El scope `read_fulfillments` está en los scopes por defecto; el campo **`fulfillmentStatus`** se obtiene de cada **order** en la respuesta de `orders.json` y se expone en `NormalizedOrder.fulfillmentStatus`. No hay sincronización ni lectura separada de la API de fulfillments.

**Tienda**

- **Endpoint:** `GET https://{shop}/admin/api/2026-01/shop.json`.  
  Uso: `getStoreInfo` y también internamente en `saveAccessToken` para obtener `shopName` si no se pasa.

---

### 11️⃣ ¿Sincronización inicial?

- **No hay sincronización inicial** al conectar la tienda. No se hace un “pull” de los últimos X pedidos (ni productos) al completar OAuth.  
  Los datos se piden **on-demand**: cuando una llamada de voz inicia, en `streams.gateway` se llama a `loadInitialShopifyContext`, que hace `getStoreInfo`, `getProducts` y `getOrders` para esa sesión (userId + shopDomain) y carga ese contexto en la sesión. También hay consultas bajo demanda cuando el agente necesita datos actualizados (p. ej. en `streams.gateway` según instrucciones/eventos).  
  Por tanto: **solo consulta on-demand**, no importación inicial de últimos X pedidos.

---

### 12️⃣ ¿Tenemos rate limit handling?

- **No** en el módulo Shopify. Las llamadas a la API de Shopify (axios en `shopify.service.ts`) no comprueban el header `X-Shopify-Shop-Api-Call-Limit` ni reaccionan a **429**. No hay retry con backoff ni cola para 429.  
  Si Shopify devuelve 429, la petición falla y el error se propaga (p. ej. como `BadRequestException` o error de axios).  
  **Recomendación:** Implementar detección de 429, lectura de `Retry-After` si existe, y reintentos con backoff (exponencial) para las llamadas a la API de Shopify.

---

## 🧠 Arquitectura y escalabilidad

### 13️⃣ ¿Cada request del agente identifica la tienda correcta usando shop_domain?

- **Sí.** El flujo es:
  1. En **calls.controller** (Twilio webhook de entrada de llamada): se obtiene el agente y de `agent.integrations.shopify` (array) se toma la primera tienda conectada (`firstShopify?.shopDomain`). Ese `shopDomain` se inyecta en los parámetros del stream como **`shopDomain`** (custom parameter de Twilio).
  2. En **streams.gateway**: al iniciar la sesión se leen `customParameters.userId` y `customParameters.shopDomain`; se guardan en `session.shopifyContext.shopDomain` y en `session.userId`.
  3. Todas las llamadas a Shopify desde el gateway usan **siempre** `session.userId` y `session.shopifyContext.shopDomain` (p. ej. `getStoreInfo(userId, shopDomain)`, `getProducts`, `getOrders`, y las búsquedas bajo demanda). No se usa un “shop por defecto” global.

Por tanto, cada request del agente identifica la tienda por **shop_domain** (y usuario).

---

### 14️⃣ ¿Nunca usamos un token global?

- **Correcto.** No hay token global. El token se obtiene siempre por (userId, shop): `getAccessToken(userId, shop)` consulta `shopifyStores` con `shopDomain` y `ownerUserId` y `status === 'active'`. Cada tienda tiene su propio `accessToken` en su documento.

---

### 15️⃣ ¿El token está cifrado en base de datos?

- **No.** El `accessToken` se guarda en claro en el documento de `shopifyStores`. No hay cifrado ni uso de KMS/env vars para cifrado en reposo.  
  **Recomendación:** Cifrar el token en reposo (p. ej. con una clave en env) para cumplir buenas prácticas de producción.

---

### 16️⃣ ¿Podemos escalar a 100+ tiendas sin cambios estructurales?

- **Sí, a nivel de modelo de datos y autenticación.** Firestore escala bien con muchos documentos; las consultas por `shopDomain` + `ownerUserId` (y `status`) están soportadas por índices compuestos descritos en el README del módulo. No hay límite artificial de tiendas por usuario ni por instancia.  
  Consideraciones:
  - **Rate limits de Shopify:** Con 100+ tiendas, las llamadas on-demand pueden acercarse a límites por tienda; el punto 12 (manejo de 429 y retry) sería importante.
  - **Webhooks:** Si se añaden webhooks, un único endpoint puede atender a todas las tiendas; la identificación por `X-Shopify-Shop-Domain` (o similar) y el uso de `shopifyStores` por `shopDomain` permiten escalar.
  - **Token en claro:** Para cumplimiento y seguridad en escalado, convendría cifrado (punto 15).

En resumen: la arquitectura es multi-tenant y escalable; las mejoras sugeridas (HMAC callback, webhooks, 429, cifrado) refuerzan producción pero no son bloqueantes estructurales para 100+ tiendas.

---

## 🎯 Resumen: flujo actual vs objetivo

| Aspecto | Estado actual |
|--------|----------------|
| Usuario SaaS → OAuth | ✅ Flujo completo: /auth (Firebase) → state dinámico en `oauthSessions` → redirect a Shopify → callback con validación de state y dominio. |
| Seguridad OAuth | ⚠️ Falta validación **HMAC** en el callback. |
| Token almacenado | ✅ Por tienda en `shopifyStores`; ⚠️ **no cifrado**. |
| Multi-tenant real | ✅ Sí: N tiendas por usuario, identificación por shop_domain en cada request del agente. |
| Webhooks | ❌ No hay `app/uninstalled` ni otros; no se limpia token al desinstalar. |
| Consumo API | ✅ Pedidos, productos, tienda (y fulfillmentStatus en orders); on-demand, sin sync inicial. |
| Rate limit 429 | ❌ No manejado. |

**Conclusión:** La integración está implementada y es multi-tenant; para considerarla lista para producción según buenas prácticas de Shopify y seguridad, se recomienda: (1) validar HMAC en el callback, (2) registrar y manejar webhook `app/uninstalled` (y opcionalmente otros), (3) manejar 429 con retry/backoff, (4) valorar cifrado del token en base de datos.

---

*Documento generado a partir del código en `src/shopify`, `src/calls`, `src/streams` y `src/shopify/README.md`.*
