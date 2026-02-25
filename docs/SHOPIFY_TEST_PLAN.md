# 🧪 Plan de Pruebas: Shopify Integration (Llamalo.ai)

Este documento detalla los procedimientos manuales para probar y certificar la resiliencia y seguridad de la integración de Shopify en entornos de desarrollo y staging.

## 1. Simulación de Rate Limits (Error 429)

El objetivo es saturar intencionalmente la API de Shopify para disparar el interceptor de Axios y verificar el *backoff* exponencial y el manejo del límite de reintentos.

### Pasos
1. Abre `src/shopify/shopify.service.ts` y ubica un método seguro de lectura, por ejemplo `getStoreInfo`.
2. En tu controlador, o temporalmente al final de la inicialización, crea un bucle que envíe 50 o más peticiones concurrentes a la API de Shopify de una tienda activa:
   ```typescript
   const promises = Array.from({ length: 60 }).map(() => 
     this.shopifyService.getStoreInfo(userId, shopDomain)
   );
   await Promise.all(promises);
   ```
3. Ejecuta el código.
4. **Resultado Esperado:** 
   - En la consola del servidor aparecerán advertencias: `[Shopify API] 429 Rate Limit en ... Reintento 1/3 en 500ms...`.
   - La aplicación **no debe colapsar** (`UnhandledPromiseRejection`).
   - Las peticiones que reciban el 429 esperarán el tiempo indicado por el header `Retry-After` (o el backoff) y se completarán exitosamente en el 2º o 3º intento.
   - Si superan los 3 intentos, se lanzará un error estructurado y el log dirá: `Max retries (3) alcanzado por rate limit`.

---

## 2. Verificación de Seguridad: HMAC Inválido

Asegurar que los endpoints públicos (`/shopify/callback` y `/shopify/webhooks`) rechazan inmediatamente cargas útiles falsificadas o mutadas.

### Pasos para probar Webhooks
1. Copia un payload válido de un webhook `app/uninstalled` desde la documentación de Shopify.
2. Abre Postman o cURL y haz un `POST` a tu endpoint local/ngrok (`/shopify/webhooks`).
3. Añade cabeceras simuladas:
   - `X-Shopify-Topic`: `app/uninstalled`
   - `X-Shopify-Shop-Domain`: `test-store.myshopify.com`
   - `X-Shopify-Webhook-Id`: `12345-abcde`
   - `X-Shopify-Hmac-Sha256`: `firma_falsa_o_vacia_base64`
4. **Resultado Esperado:**
   - La API debe devolver inmediatamente un **HTTP 401 Unauthorized**.
   - El log del servidor debe imprimir: `HMAC inválido para el webhook app/uninstalled de test-store.myshopify.com`.
   - La base de datos (Firestore) no debe sufrir modificaciones.

---

## 3. Idempotencia: Webhooks Duplicados

Shopify puede reintentar enviar el mismo webhook si detecta lentitud en la respuesta o errores de red. La idempotencia garantiza que la lógica de negocio solo se ejecute la primera vez.

### Pasos
1. Obtén la firma HMAC real y el payload de un webhook emitido por tu tienda de desarrollo (puedes capturarlo temporalmente en consola o usar el entorno de pruebas de Shopify Admin).
2. Asegúrate de tener un `X-Shopify-Webhook-Id` válido (ej. `test-webhook-id-001`).
3. Realiza la primera petición `POST` al endpoint `/shopify/webhooks`.
   - **Resultado Esperado 1:** HTTP 200 OK. El log mostrará `Procesando desinstalación para la tienda...` y el registro correspondiente en la colección `webhookEvents` de Firestore será creado con ese ID.
4. Menos de 5 segundos después (o en cualquier momento futuro), dispara **exactamente la misma petición** con el mismo `X-Shopify-Webhook-Id`.
   - **Resultado Esperado 2:** HTTP 200 OK. La API devolverá la respuesta instantáneamente. El log del servidor debe mostrar: `[Idempotencia] Ignorando webhook duplicado: test-webhook-id-001 (app/uninstalled)`.
   - Verifica en Firestore que la lógica interna (como marcar la tienda en estado `revoked`) no se ejecutó dos veces, y que no se lanzaron errores inesperados.

---

## 4. Pruebas de Cifrado (Opcional - Production Strict Mode)

Verifica que el servicio de cifrado es robusto ante cambios de llave o fallos.

1. Conecta una tienda para que se guarde un token válido en `shopifyStores` (verifícalo en Firestore; debe ser un string largo con formato `iv:authTag:cifrado`).
2. Detén el servidor, cambia tu variable de entorno `ENCRYPTION_KEY` por otra de 32 bytes o aleatoria, e inicia el servidor de nuevo.
3. Intenta hacer una consulta (ej. `getStoreInfo`).
4. **Resultado Esperado:**
   - Como la llave o el `authTag` no coinciden, en modo **desarrollo** el sistema lanzará un log `CRITICAL: Fallo de autenticación al descifrar datos`.
   - En modo **producción**, la app lanzará un `Error` duro y rechazará el uso de ese token en texto corrupto, evitando enviar basura a Shopify.