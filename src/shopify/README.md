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
APP_URL=http://localhost:3000  # URL base de tu aplicación (para callbacks)
```

## Endpoints

### 1. GET /shopify/auth
**Público** - Inicia el flujo OAuth de Shopify

**Query Params:**
- `shop` (requerido): Dominio de la tienda, ej: `llamaloai-dev.myshopify.com`
- `userId` (opcional): ID del usuario para asociar la tienda

**Ejemplo:**
```
GET /shopify/auth?shop=llamaloai-dev.myshopify.com&userId=user123
```

**Respuesta:** Redirección 302 a la página de autorización de Shopify

---

### 2. GET /shopify/callback
**Público** - Callback OAuth de Shopify

**Query Params:**
- `shop` (requerido): Dominio de la tienda
- `code` (requerido): Código de autorización de Shopify
- `state` (opcional): Contiene el userId pasado en el flujo OAuth

**Ejemplo:**
```
GET /shopify/callback?shop=llamaloai-dev.myshopify.com&code=abc123&state=user123
```

**Respuesta:**
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

## Flujo OAuth Completo

1. **Usuario inicia conexión:**
   ```
   GET /shopify/auth?shop=tienda.myshopify.com&userId=user123
   ```

2. **Usuario es redirigido a Shopify** para autorizar la aplicación

3. **Shopify redirige de vuelta:**
   ```
   GET /shopify/callback?shop=tienda.myshopify.com&code=abc123&state=user123
   ```

4. **El sistema:**
   - Intercambia el código por un `access_token`
   - Guarda el token en Firestore asociado al `userId`
   - Responde con éxito

5. **Usuario puede usar los endpoints protegidos:**
   ```
   GET /shopify/store?shop=tienda.myshopify.com
   GET /shopify/products?shop=tienda.myshopify.com
   GET /shopify/orders?shop=tienda.myshopify.com
   ```

## Almacenamiento en Firestore

Los tokens se guardan en la colección `users` bajo el campo `shopify`:

```json
{
  "shopify": {
    "shops": {
      "tienda.myshopify.com": {
        "accessToken": "shpat_xxxxx",
        "connectedAt": "2024-01-01T00:00:00.000Z"
      }
    }
  }
}
```

## Scopes de Shopify

El módulo solicita los siguientes permisos:
- `read_products`
- `read_orders`
- `read_customers`
- `read_fulfillments`
- `read_shipping`

## Versión de API

Se utiliza la versión **2026-01** de la API de Shopify.

## Notas de Seguridad

- El `userId` en el parámetro `state` del OAuth debería estar encriptado en producción
- Los tokens de acceso se almacenan de forma segura en Firestore
- Todos los endpoints protegidos requieren autenticación Firebase

## Testing en Swagger

1. Accede a `/api` en tu aplicación
2. Busca el tag `shopify`
3. Prueba los endpoints directamente desde la interfaz de Swagger
4. Para endpoints protegidos, usa el botón "Authorize" con tu token Firebase

