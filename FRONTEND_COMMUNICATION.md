# Comunicación al equipo de Frontend: Cambio en integrations.shopify

## 🔔 Cambio importante en la API

Hemos actualizado el modelo de datos para permitir que los usuarios conecten **múltiples tiendas Shopify**.

### ⚠️ Cambio en el endpoint `/users/profile`

**Antes:**

```json
{
  "userId": "abc123",
  "integrations": {
    "shopify": {
      "connected": true,
      "shopDomain": "llamaloai-dev.myshopify.com"
    }
  }
}
```

**Ahora:**

```json
{
  "userId": "abc123",
  "integrations": {
    "shopify": [
      {
        "connected": true,
        "shopDomain": "llamaloai-dev.myshopify.com"
      },
      {
        "connected": true,
        "shopDomain": "new-llamalo.myshopify.com"
      }
    ]
  }
}
```

## 📝 Qué necesitan actualizar

### 1. **Tipos/Interfaces en TypeScript**

Si tienen tipos definidos para el perfil del usuario, actualizar:

```typescript
// ❌ Antes
interface UserProfile {
  integrations?: {
    shopify?: {
      connected: boolean;
      shopDomain: string;
    };
  };
}

// ✅ Ahora
interface UserProfile {
  integrations?: {
    shopify?: Array<{
      connected: boolean;
      shopDomain: string;
    }>;
  };
}
```

### 2. **Leer datos de Shopify**

Actualizar el código que lee `integrations.shopify`:

```typescript
// ❌ Antes
const shopDomain = user.integrations?.shopify?.shopDomain;
const isConnected = user.integrations?.shopify?.connected;

// ✅ Ahora - Primera tienda
const firstShop = user.integrations?.shopify?.[0];
const shopDomain = firstShop?.shopDomain;
const isConnected = firstShop?.connected;

// ✅ O mostrar todas las tiendas
const shops = user.integrations?.shopify || [];
shops.forEach((shop) => {
  console.log(
    `${shop.shopDomain} - ${shop.connected ? 'Conectada' : 'Desconectada'}`,
  );
});
```

### 3. **UI para múltiples tiendas**

Consideren mostrar **todas las tiendas** conectadas en la interfaz:

```jsx
// Ejemplo en React
function ShopifyIntegrations({ user }) {
  const shops = user.integrations?.shopify || [];

  if (shops.length === 0) {
    return <p>No hay tiendas conectadas</p>;
  }

  return (
    <div>
      <h3>Tiendas Shopify conectadas:</h3>
      <ul>
        {shops.map((shop, index) => (
          <li key={index}>
            {shop.shopDomain}
            {shop.connected ? ' ✅' : ' ❌'}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## 🔄 Endpoints de Shopify (sin cambios funcionales)

Los endpoints de Shopify siguen funcionando igual:

- `POST /shopify/auth?shop=...` → Conecta una nueva tienda (se añade al array)
- `POST /shopify/revoke?shop=...` → Desconecta una tienda (se elimina del array)
- `GET /shopify/store?shop=...` → Obtiene info de una tienda específica
- `GET /shopify/products?shop=...` → Obtiene productos de una tienda específica
- `GET /shopify/orders?shop=...` → Obtiene pedidos de una tienda específica

**Importante:** Ahora el parámetro `shop` es obligatorio en todos los endpoints que lo aceptan, para especificar con qué tienda trabajar.

## 🧪 Testing recomendado

1. **Ver perfil de usuario** → Verificar que `integrations.shopify` es un array
2. **Conectar primera tienda** → Array debe tener 1 elemento
3. **Conectar segunda tienda** → Array debe tener 2 elementos
4. **Desconectar una tienda** → Se elimina del array
5. **Desconectar última tienda** → Array queda vacío `[]`

## 📅 Migración de datos

Los usuarios existentes con una tienda Shopify conectada ya fueron migrados automáticamente:

- Si tenían `shopify: { connected: true, shopDomain: "..." }`, ahora tienen `shopify: [{ connected: true, shopDomain: "..." }]`
- Si no tenían nada en `shopify`, ahora tienen `shopify: []`

## ❓ Preguntas frecuentes

**Q: ¿Qué pasa con usuarios que ya tenían una tienda conectada?**  
A: Se migraron automáticamente a un array con un solo elemento. No se pierde ningún dato.

**Q: ¿Puedo seguir mostrando solo la primera tienda en la UI?**  
A: Sí, usen `integrations.shopify[0]` para obtener la primera tienda. Pero recomendamos mostrar todas las tiendas si el usuario tiene varias.

**Q: ¿Cómo sé qué tienda usar en las llamadas telefónicas?**  
A: El backend usa automáticamente la **primera tienda conectada** del array. Si quieren cambiar esto, podemos añadir lógica para seleccionar una tienda específica.

**Q: ¿El backend valida que no haya tiendas duplicadas?**  
A: Sí, si intentas conectar una tienda que ya está en el array, se actualiza (no se duplica).

## 📞 Contacto

Si tienen dudas o encuentran problemas, por favor contactar al equipo de backend.
