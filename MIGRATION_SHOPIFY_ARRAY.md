# Migración: integrations.shopify de objeto a array

## Resumen del cambio

Se ha modificado el modelo de datos para que `integrations.shopify` sea un **array** de objetos en lugar de un objeto único. Esto permite a los usuarios conectar múltiples tiendas Shopify.

### Antes

```typescript
integrations: {
  shopify?: {
    connected: boolean;
    shopDomain: string;
  }
}
```

### Después

```typescript
integrations: {
  shopify?: Array<{
    connected: boolean;
    shopDomain: string;
  }>
}
```

## Archivos modificados

1. **`src/users/users.service.ts`** - Tipos `UserData` y `UserProfileResponse`
2. **`src/users/dto/user-profile-response.dto.ts`** - DTO de respuesta
3. **`src/shopify/shopify.service.ts`**:
   - `saveAccessToken`: Ahora añade/actualiza tiendas en el array
   - `revokeStore`: Elimina tiendas del array
4. **`src/auth/auth.service.ts`** - Nuevos usuarios se crean con `shopify: []`
5. **`src/calls/calls.controller.ts`** - Usa la primera tienda conectada del array

## Script de migración de datos

Los usuarios existentes con `integrations.shopify` como objeto deben migrarse al nuevo formato. Puedes usar este script en una Cloud Function o ejecutarlo manualmente:

```javascript
// Script de migración para Firebase Admin SDK
const admin = require('firebase-admin');
const db = admin.firestore();

async function migrateShopifyIntegrations() {
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  let migrated = 0;
  let alreadyArray = 0;
  let noShopify = 0;

  const batch = db.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Si no tiene integrations.shopify, saltar
    if (!data.integrations || !data.integrations.shopify) {
      noShopify++;
      continue;
    }

    const shopify = data.integrations.shopify;

    // Si ya es un array, saltar
    if (Array.isArray(shopify)) {
      alreadyArray++;
      continue;
    }

    // Si es un objeto con shopDomain, convertir a array
    if (typeof shopify === 'object' && shopify.shopDomain) {
      const newShopifyArray = [
        {
          connected: !!shopify.connected,
          shopDomain: shopify.shopDomain,
        },
      ];

      batch.update(doc.ref, {
        'integrations.shopify': newShopifyArray,
      });

      migrated++;
      batchCount++;

      // Firestore limita a 500 operaciones por batch
      if (batchCount >= 500) {
        await batch.commit();
        console.log(`Migrados ${migrated} usuarios (batch commit)`);
        batchCount = 0;
      }
    }
  }

  // Commit final
  if (batchCount > 0) {
    await batch.commit();
  }

  console.log('Migración completada:');
  console.log(`- Migrados: ${migrated}`);
  console.log(`- Ya eran arrays: ${alreadyArray}`);
  console.log(`- Sin Shopify: ${noShopify}`);
  console.log(`- Total: ${snapshot.size}`);
}

// Ejecutar
migrateShopifyIntegrations()
  .then(() => console.log('✅ Migración exitosa'))
  .catch((err) => console.error('❌ Error en migración:', err));
```

## Compatibilidad hacia atrás

El código está diseñado para manejar ambos formatos durante la transición:

- En `shopify.service.ts` (`saveAccessToken` y `revokeStore`), se trata `shopify` como array, incluso si está vacío.
- En `calls.controller.ts`, se busca la primera tienda conectada en el array.
- Los nuevos usuarios se crean directamente con `shopify: []`.

## Testing

Después de la migración, verifica:

1. **Usuarios existentes**: Confirma que sus tiendas Shopify migraron correctamente al array.
2. **Nuevos usuarios**: Se crean con `shopify: []`.
3. **Conectar tienda**: `POST /shopify/auth` debe añadir tiendas al array.
4. **Revocar tienda**: `POST /shopify/revoke` debe eliminar tiendas del array.
5. **Múltiples tiendas**: Un usuario puede conectar varias tiendas y todas aparecen en el array.
6. **Llamadas**: Las llamadas usan la primera tienda conectada del array.

## Comunicación con frontend

Ver archivo `FRONTEND_COMMUNICATION.md` para el mensaje detallado al equipo de frontend.
