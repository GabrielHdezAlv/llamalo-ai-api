# Shopify Integration Module

Módulo de integración con Shopify para LlamaloAI API.

## Estructura

```
shopify/
├── dto/
│   ├── shopify-auth-query.dto.ts
│   ├── shopify-callback-query.dto.ts
│   ├── shopify-callback-response.dto.ts
│   ├── shopify-store-response.dto.ts
│   ├── shopify-products-response.dto.ts
│   └── shopify-orders-response.dto.ts
├── shopify.controller.ts
├── shopify.service.ts
├── shopify.module.ts
└── README.md
```

## Variables de Entorno

Agregar al archivo `.env`:

```env
SHOPIFY_API_KEY=tu_api_key_de_shopify
SHOPIFY_API_SECRET=tu_api_secret_de_shopify
APP_URL=http://localhost:3000  # URL base del backend (para callbacks de Shopify)
```

## Endpoints

### 1. GET /shopify/auth

**Protegido** - Inicia el flujo OAuth de Shopify (requiere autenticación Firebase)

**Autenticación:** Requerida (Firebase Bearer Token)

**Query Params:**

- `shop` (requerido): Dominio de la tienda, ej: `llamaloai-dev.myshopify.com`
- `returnTo` (opcional): URL absoluta del frontend a la que redirigir tras autorizar en Shopify. Se guarda tal cual y se usa en el callback.

**Ejemplo:**

```
GET /shopify/auth?shop=llamaloai-dev.myshopify.com&returnTo=https://app.ejemplo.com/dashboard/agents/create
Authorization: Bearer <firebase_token>
```

**Respuesta:** Redirección 302 a la página de autorización de Shopify

**Nota:** El sistema crea automáticamente una sesión OAuth segura y la usa como `state` en el flujo OAuth.

---

### 2. GET /shopify/callback

**Público** - Callback OAuth de Shopify

**Query Params:**

- `shop` (requerido): Dominio de la tienda
- `code` (requerido): Código de autorización de Shopify
- `state` (requerido): ID de sesión OAuth (`oauthSessionId`) generado en `/auth`

**Ejemplo:**

```
GET /shopify/callback?shop=llamaloai-dev.myshopify.com&code=abc123&state=oauthSessionId123
```

**Nota:** El sistema valida la sesión OAuth, recupera el `userId` de forma segura y elimina la sesión después de usarla.

**Respuesta (si se envió `returnTo` en `/auth`):** Redirección 302 a esa URL con query params:

- **Éxito:** `?shopify=success&shop=<dominio>`
- **Error:** `?shopify=error&code=400|401&message=<mensaje>`

**Respuesta (si no hay redirect configurado):** JSON

```json
{
  "success": true,
  "message": "Token de acceso guardado correctamente"
}
```

---

### 3. GET /shopify/store

**Protegido** - Obtiene información de la tienda

**Autenticación:** Requerida (Firebase Bearer Token)

**Query Params:**

- `shop` (requerido): Dominio de la tienda

**Ejemplo:**

```
GET /shopify/store?shop=llamaloai-dev.myshopify.com
Authorization: Bearer <firebase_token>
```

**Respuesta:**

```json
{
  "shop": {
    "id": 12345678,
    "name": "Mi Tienda",
    "email": "tienda@example.com",
    "domain": "mi-tienda.myshopify.com",
    "country": "ES",
    "currency": "EUR",
    "timezone": "Europe/Madrid",
    "created_at": "2024-01-01T00:00:00-00:00",
    "updated_at": "2024-01-01T00:00:00-00:00"
  }
}
```

---

### 4. GET /shopify/products

**Protegido** - Obtiene lista de productos

**Autenticación:** Requerida (Firebase Bearer Token)

**Query Params:**

- `shop` (requerido): Dominio de la tienda

**Ejemplo:**

```
GET /shopify/products?shop=llamaloai-dev.myshopify.com
Authorization: Bearer <firebase_token>
```

**Respuesta:**

```json
{
  "products": [
    {
      "id": 123456789,
      "title": "Producto Ejemplo",
      "handle": "producto-ejemplo",
      "status": "active",
      ...
    }
  ]
}
```

---

### 5. GET /shopify/orders

**Protegido** - Obtiene lista de pedidos

**Autenticación:** Requerida (Firebase Bearer Token)

**Query Params:**

- `shop` (requerido): Dominio de la tienda

**Ejemplo:**

```
GET /shopify/orders?shop=llamaloai-dev.myshopify.com
Authorization: Bearer <firebase_token>
```

**Respuesta:**

```json
{
  "orders": [
    {
      "id": 123456789,
      "name": "#1001",
      "financial_status": "paid",
      "total_price": "99.99",
      "currency": "EUR",
      ...
    }
  ]
}
```

## Flujo OAuth Completo (Seguro)

1. **Usuario autenticado inicia conexión:**

   ```
   GET /shopify/auth?shop=tienda.myshopify.com
   Authorization: Bearer <firebase_token>
   ```

   - El sistema crea una sesión OAuth segura (`oauthSessionId`)
   - Se guarda en Firestore con `userId`, `shopDomain`, `createdAt`, `expiresAt` (10 min)
   - Se redirige a Shopify con `state=oauthSessionId`

2. **Usuario es redirigido a Shopify** para autorizar la aplicación

3. **Shopify redirige de vuelta:**

   ```
   GET /shopify/callback?shop=tienda.myshopify.com&code=abc123&state=oauthSessionId
   ```

4. **El sistema:**
   - Valida la sesión OAuth (existe, no expirada, shopDomain coincide)
   - Recupera el `userId` de la sesión
   - Intercambia el código por un `access_token`
   - Guarda el token en `shopifyStores` asociado al `userId`
   - Elimina la sesión OAuth (one-time use)
   - Responde con éxito

5. **Usuario puede usar los endpoints protegidos:**
   ```
   GET /shopify/store?shop=tienda.myshopify.com
   Authorization: Bearer <firebase_token>
   GET /shopify/products?shop=tienda.myshopify.com
   Authorization: Bearer <firebase_token>
   GET /shopify/orders?shop=tienda.myshopify.com
   Authorization: Bearer <firebase_token>
   ```

### Seguridad

- ✅ El `userId` nunca se expone en URLs o parámetros públicos
- ✅ Las sesiones OAuth expiran en 10 minutos
- ✅ Las sesiones son de un solo uso (se eliminan después del callback)
- ✅ Validación de `shopDomain` para prevenir ataques CSRF
- ✅ El endpoint `/auth` ahora requiere autenticación Firebase

## Almacenamiento en Firestore

### Colección `oauthSessions`

Sesiones OAuth temporales para el flujo de autenticación:

```json
{
  "id": "oauthSessionId123",
  "userId": "user123",
  "shopDomain": "tienda.myshopify.com",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "expiresAt": "2024-01-01T00:10:00.000Z"
}
```

**Características:**

- Expiran en 10 minutos
- Se eliminan después de usarse (one-time use)
- Previenen ataques CSRF

### Colección `shopifyStores`

Los tokens y datos de las tiendas se guardan en una colección dedicada:

```json
{
  "id": "store123",
  "shopDomain": "tienda.myshopify.com",
  "shopName": "Mi Tienda",
  "accessToken": "shpat_xxxxx",
  "scopes": [
    "read_products",
    "read_orders",
    "read_customers",
    "read_fulfillments",
    "read_shipping"
  ],
  "ownerUserId": "user123",
  "status": "active",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

### Referencia en `users`

En la colección `users` solo se guarda una referencia simple:

```json
{
  "integrations": {
    "shopify": {
      "connected": true,
      "shopDomain": "tienda.myshopify.com"
    }
  }
}
```

**Importante:** Los tokens NUNCA se guardan en la colección `users`, solo referencias.

## Scopes de Shopify

### Scopes por Defecto (v1 - Cumplimiento GDPR)

El módulo solicita los siguientes permisos por defecto:

- `read_products` - Leer productos
- `read_orders` - Leer pedidos
- `read_fulfillments` - Leer cumplimientos/envíos
- `read_shipping` - Leer información de envío

### ⚠️ ADVERTENCIA LEGAL: read_customers

**`read_customers` NO está incluido por defecto** por razones de cumplimiento legal:

- **GDPR (UE)**: Acceso a datos personales requiere justificación legal
- **Revisión de Shopify**: Pueden solicitar revisión de la aplicación
- **Responsabilidad**: Debes tener base legal para procesar datos personales

### Agregar read_customers (si es necesario)

Si necesitas acceso a datos de clientes, configura la variable de entorno:

```env
SHOPIFY_SCOPES=read_products,read_orders,read_customers,read_fulfillments,read_shipping
```

**Antes de agregar `read_customers`, asegúrate de:**

1. Tener base legal para procesar datos personales (GDPR Art. 6)
2. Tener política de privacidad actualizada
3. Documentar el propósito del procesamiento
4. Considerar solicitar consentimiento explícito

## Versión de API

Se utiliza la versión **2026-01** de la API de Shopify.

## Índices de Firestore Requeridos

Para que las consultas funcionen correctamente, necesitas crear los siguientes índices compuestos en Firestore:

1. **oauthSessions** - Para búsquedas por ID:
   - Collection: `oauthSessions`
   - Fields: `id` (Ascending) - Este es el document ID, no requiere índice compuesto
   - Query scope: Collection

2. **shopifyStores** - Para búsquedas por dominio y usuario:
   - Collection: `shopifyStores`
   - Fields: `shopDomain` (Ascending), `ownerUserId` (Ascending)
   - Query scope: Collection

3. **shopifyStores** - Para búsquedas por dominio, usuario y estado:
   - Collection: `shopifyStores`
   - Fields: `shopDomain` (Ascending), `ownerUserId` (Ascending), `status` (Ascending)
   - Query scope: Collection

4. **shopifyStores** - Para búsquedas por usuario y estado:
   - Collection: `shopifyStores`
   - Fields: `ownerUserId` (Ascending), `status` (Ascending)
   - Query scope: Collection

**Nota:** Firestore te mostrará un enlace para crear estos índices automáticamente cuando ejecutes las consultas por primera vez.

## Notas de Seguridad

- El `userId` en el parámetro `state` del OAuth debería estar encriptado en producción
- Los tokens de acceso se almacenan en la colección dedicada `shopifyStores`, nunca en `users`
- Todos los endpoints protegidos requieren autenticación Firebase
- Los tokens se pueden encriptar antes de guardar (recomendado para producción)

## Testing en Swagger

1. Accede a `/api` en tu aplicación
2. Busca el tag `shopify`
3. Prueba los endpoints directamente desde la interfaz de Swagger
4. Para endpoints protegidos, usa el botón "Authorize" con tu token Firebase
