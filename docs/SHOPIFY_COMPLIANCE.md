# 🛡️ Política de Acceso a Datos y Cumplimiento – Llamalo.ai

Llamalo.ai es un asistente virtual de soporte post-venta por voz para e-commerce. Nuestra app requiere acceso limitado a datos de la tienda únicamente bajo demanda, cumpliendo el principio de minimización de datos (Data Minimization): no realizamos descargas masivas ni sincronizaciones históricas.

## Scopes Solicitados y Justificación

### 1. read_customers
**Uso:** Autenticación dinámica del cliente durante la llamada.
**Justificación:** La IA identifica al cliente mediante su número de teléfono (Caller ID) y verifica que existe un perfil asociado en Shopify para ofrecer respuestas seguras y personalizadas.

### 2. read_orders
**Uso:** Resolver consultas sobre pedidos en tiempo real.
**Justificación:** Solo consultamos los pedidos recientes del cliente identificado para informar sobre estado de envío, fulfillment status y número de seguimiento. Los datos se usan únicamente durante la llamada y no se almacenan.

### 3. read_products
**Uso:** Asistencia sobre disponibilidad, características o precios de productos durante la llamada.
**Justificación:** Permite a la IA responder dudas inmediatas de ventas o productos sin acceder a toda la base de datos.

## Ciclo de Vida de los Datos
* Todos los datos se procesan en memoria durante la sesión de llamada activa.
* Tras finalizar la llamada, el contexto se destruye automáticamente.
* No se almacena información de clientes ni pedidos fuera de esta sesión.

Nuestra app cumple con GDPR y CCPA y no utiliza datos de los clientes para fines comerciales o marketing.