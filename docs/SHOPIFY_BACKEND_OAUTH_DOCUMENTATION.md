# 📘 Documentación Técnica: Integración Shopify Backend

Esta documentación describe la arquitectura y los flujos de seguridad implementados en la API de Llamalo.ai para la integración con Shopify. Toda la implementación cumple con los requisitos de producción de Shopify App Store.

## 1. Flujo OAuth (Autorización)

El flujo de autorización sigue el estándar de OAuth 2.0 (Auth Code Grant) e interviene cuando un usuario conecta su tienda.

1. **`GET /shopify/auth`**: 
   - Verifica la sesión del usuario vía Firebase Auth.
   - Crea un registro seguro de "estado" (`oauthSessionId`) en Firestore (`oauthSessions`) que expira a los 10 minutos para prevenir ataques CSRF.
   - Retorna (o redirige) a la URL de autorización en Shopify con los `scopes` configurados.
2. **`GET /shopify/callback`**:
   - Endpoint público que recibe el redireccionamiento de Shopify.
   - **Paso crítico**: Valida la integridad del mensaje y origen usando `validateShopifyHmac`.
   - Verifica que la sesión temporal coincida y no haya expirado.
   - Intercambia el código por el `access_token` permanente (offline access).
   - Guarda el token de forma cifrada (ver sección de Seguridad).

## 2. Validación HMAC

Cualquier petición iniciada por Shopify (Callbacks de OAuth y Webhooks) es estrictamente verificada.
- **En OAuth**: Se extrae el query parameter `hmac`. Se ordenan lexicográficamente el resto de parámetros y se firma con SHA-256 usando el `SHOPIFY_API_SECRET`.
- **En Webhooks**: Se extrae la cabecera `X-Shopify-Hmac-Sha256` y se valida comparando su base64 con la firma SHA-256 del `req.rawBody` original de la petición, evitando cualquier mutación de parseadores JSON.

## 3. Webhooks (app/uninstalled)

Al guardar el token en la base de datos, el backend registra automáticamente en Shopify el webhook de `app/uninstalled`.

### Arquitectura Idempotente
Shopify exige que los webhooks respondan con HTTP 200 en menos de 5 segundos y tiene una política agresiva de reintentos en caso de cortes de red.
- **Endpoint:** `POST /shopify/webhooks`
- **Idempotencia:** Extraemos `X-Shopify-Webhook-Id`. Antes de procesar la lógica, usamos Firebase Admin `create()` en la colección `webhookEvents`. Si la operación falla con código `ALREADY_EXISTS`, sabemos que es un reintento y devolvemos 200 inmediatamente.
- **Procesamiento Background:** Si es válido, disparamos la lógica asíncronamente. Se busca la tienda en Firestore, se marca como `status: 'revoked'`, se elimina el token, y se limpia el array `integrations.shopify` del usuario.

## 4. Seguridad de Datos en Reposo (Cifrado de Tokens)

Siguiendo políticas de seguridad Zero-Trust, ningún `access_token` de Shopify se guarda en texto plano en la base de datos.
- Se implementó un servicio interno basado en `crypto` de Node.js usando **AES-256-GCM**.
- **`encrypt(token)`**: Genera un IV (Initialization Vector) aleatorio y devuelve una cadena de la forma `iv:authTag:textoCifrado`.
- **`decrypt(encryptedToken)`**: Restaura el token al vuelo en memoria. Si el `authTag` es inválido (intento de alteración o cambio de llave no planeado), lanzará un error crítico en producción.
- **Producción Strict Mode**: En entornos de producción (`NODE_ENV=production`), está totalmente prohibido ejecutar la app sin la variable `ENCRYPTION_KEY`. No se permiten fallbacks a tokens no cifrados.
- **Manejo de Memoria**: El token descifrado solo vive en las cabeceras Axios durante el tiempo de petición y jamás se renderiza en endpoints del frontend.

## 5. Resiliencia y Rate Limiting (429)

Las llamadas a la API Admin de Shopify (`/admin/api/2026-01/*`) están protegidas por un **Interceptor de Axios**.
- Detecta errores `429 Too Many Requests`.
- Si existe, lee y respeta el header `Retry-After` de Shopify.
- Si no existe, implementa un **Backoff Exponencial Manual** (500ms, 1000ms, 2000ms).
- **Límite:** Máximo 3 reintentos automatizados por petición.
- **Logs Limpios:** Registra de manera no bloqueante el evento en consola (ej: `Reintento 1/3 en 500ms...`) sin exponer datos confidenciales ni interrumpir la ejecución principal.