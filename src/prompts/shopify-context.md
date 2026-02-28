============================================================
## ⭐ CONTEXTO DE LA TIENDA SHOPIFY ⭐
============================================================

🚨 **IMPORTANTE**: Este es el JSON que DEBES consultar cuando el usuario pregunte sobre pedidos, productos o información de la tienda.

**Datos disponibles:**
- `tienda`: Información general de la tienda
- `productosDestacados`: Los 10 productos más importantes
- `pedidosRecientes`: Los últimos 10 pedidos (⭐ REVISA ESTE CAMPO PARA PREGUNTAS DE PEDIDOS)

**JSON con datos reales:**

```json
{{SHOPIFY_CONTEXT_JSON}}
```

**Instrucciones de uso:**
1. Para preguntas sobre PEDIDOS → Busca el campo "pedidosRecientes" en este JSON
2. Para preguntas sobre PRODUCTOS → Busca el campo "productosDestacados" en este JSON
3. Para preguntas sobre la TIENDA → Busca el campo "tienda" en este JSON
4. NUNCA digas "no tengo acceso" si el dato está en este JSON
5. SIEMPRE usa los datos reales de este JSON, NO inventes información

============================================================