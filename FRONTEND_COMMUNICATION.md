# Comunicación al equipo de Frontend

## 1. Shopify OAuth: redirección a "Conecta tu negocio" tras autorizar

### Cambio en el flujo de conexión Shopify

Tras autorizar la app en Shopify, el backend **ya no devuelve JSON** en la misma pestaña. Ahora **redirige (302)** a la pantalla del frontend que indiquéis, con el resultado en la URL.

### Qué debe hacer el frontend

1. **Al iniciar el flujo de conexión Shopify**  
   Llamar al backend con el query param `returnTo` apuntando a la URL absoluta de la pantalla "Conecta tu negocio":
   - Ruta a usar: **`/dashboard/agents/create`** (pantalla "Conecta tu negocio" del wizard Crear Agente).

   Ejemplo de llamada (el usuario ya está en esa pantalla o en un paso previo; al pulsar "Conectar" se abre/redirige a la URL de auth):

   ```
   GET /shopify/auth?shop=<dominio>.myshopify.com&redirect=false&returnTo=https://<vuestro-dominio>/dashboard/agents/create
   Authorization: Bearer <firebase_token>
   ```

   - `returnTo` debe ser la URL **completa** de esa pantalla (por ejemplo `http://localhost:4200/dashboard/agents/create` en local o la URL de producción).

2. **En la pantalla `/dashboard/agents/create`**  
   Al cargar la página (o al volver de Shopify), leer los **query params** de la URL:
   - **Éxito:** `shopify=success` y `shop=<dominio>`  
     → Mostrar mensaje de éxito (equivalente a 200) y actualizar el estado de la tienda conectada.
   - **Error:** `shopify=error`, `code=400` o `401`, y opcionalmente `message=<texto>`  
     → Mostrar el error según `code` y `message`.

   Recomendación: después de mostrar el mensaje, limpiar los query params de la URL (por ejemplo con `history.replace` sin esos params) para que al recargar no se vuelva a mostrar.

### Resumen para el equipo

| Qué               | Detalle                                             |
| ----------------- | --------------------------------------------------- | ---------------- |
| Ruta de retorno   | `/dashboard/agents/create`                          |
| Parámetro en auth | `returnTo=https://<origen>/dashboard/agents/create` |
| Éxito en URL      | `?shopify=success&shop=<dominio>`                   |
| Error en URL      | `?shopify=error&code=400                            | 401&message=...` |

Si no enviáis `returnTo`, el callback devolverá JSON como antes (no habrá redirección al frontend).

---

## 2. Nuevo campo `shopifyDomain` en el modelo de Agente

### 🔔 Cambio en los endpoints de Agentes

Se ha añadido el campo opcional `shopifyDomain` al modelo de agente para permitir **asociar una tienda Shopify a cada agente**. Así, al crear o editar un agente se puede indicar qué tienda de Shopify debe usar ese agente.

### Endpoints afectados

- `POST /agents` — Crear agente
- `PATCH /agents/:agentId` — Actualizar agente
- `GET /agents` — Listar agentes

### Cambios en los DTOs

**Request (crear/actualizar agente):**

Se puede enviar el campo opcional `shopifyDomain`:

```json
{
  "name": "Marta",
  "type": "inbound",
  "language": "es",
  "voiceId": "gD1IexrzCvsXPHUuT0s3",
  "firstInteraction": "Hola...",
  "agentInstruction": "Eres un asistente...",
  "phoneNumbers": { "countryCode": "+34", "number": 654316415 },
  "label": "Agente principal",
  "state": "Activo",
  "parameters": { ... },
  "shopifyDomain": "mi-tienda.myshopify.com"  // ← NUEVO (opcional)
}
```

**Response (agente en create/list/update):**

El agente devuelto incluye ahora `shopifyDomain` cuando está asignado:

```json
{
  "agentId": 1738000000000,
  "name": "Marta",
  "type": "inbound",
  "language": "es",
  ...
  "shopifyDomain": "mi-tienda.myshopify.com"  // ← NUEVO (opcional, puede ser null)
}
```

### Qué debe actualizar el frontend

1. **Tipos/Interfaces del Agente**  
   Añadir `shopifyDomain?: string | null` al tipo/interfaz del agente.

2. **Formulario de crear/editar agente**
   - Añadir un selector (dropdown, etc.) para elegir la tienda Shopify cuando el usuario tenga tiendas conectadas (`integrations.shopify`).
   - Al guardar, enviar el `shopifyDomain` seleccionado en el body del request.

3. **Vista de detalle/listado de agentes**  
   Mostrar la tienda asociada cuando el agente tenga `shopifyDomain`.

### Notas

- El dominio se normaliza en backend (se quita `https://` y barras finales).
- Para desvincular la tienda: enviar `"shopifyDomain": ""` o `null` al actualizar.
- Si no se envía `shopifyDomain` al actualizar, se conserva el valor anterior.
- Los agentes existentes no tendrán este campo (o será `undefined`/`null`); el frontend debe tratarlo como opcional.

---

## 3. Cambio en integrations.shopify (histórico)

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
