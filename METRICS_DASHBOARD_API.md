# API de Métricas del Dashboard

## Endpoint: `GET /metrics/dashboard`

Este endpoint proporciona las métricas necesarias para el dashboard del frontend, incluyendo resumen de llamadas, información de agentes y estadísticas de los últimos 7 días.

---

## Autenticación

Este endpoint requiere autenticación mediante Firebase Auth. Debe incluirse el token de autenticación en el header:

```
Authorization: Bearer <firebase_token>
```

---

## Parámetros de Query

| Parámetro | Tipo     | Requerido | Valores Permitidos                        | Default | Descripción                                     |
| --------- | -------- | --------- | ----------------------------------------- | ------- | ----------------------------------------------- |
| `period`  | `string` | No        | `day`, `week`, `month`, `6months`, `year` | `week`  | Período de filtrado para el resumen de métricas |

### Ejemplos de uso:

```
GET /metrics/dashboard?period=day
GET /metrics/dashboard?period=week
GET /metrics/dashboard?period=month
GET /metrics/dashboard?period=6months
GET /metrics/dashboard?period=year
```

---

## Respuesta

### Estructura de la Respuesta

```json
{
  "resumen": {
    "total_llamadas": 150,
    "tiempo_ahorrado": 375,
    "minutos_utilizados": 150
  },
  "agentes": [
    {
      "nombre": "Ana García",
      "tipo": "inbound",
      "minutos_totales": 150,
      "estado": "activo"
    }
  ],
  "llamadas_ultimos_7_dias": [
    {
      "fecha": "2024-01-15",
      "total": 25
    },
    {
      "fecha": "2024-01-16",
      "total": 30
    },
    // ... más días
  ]
}
```

### Campos de la Respuesta

#### `resumen`

- **`total_llamadas`** (number): Total de llamadas realizadas en el período seleccionado
- **`tiempo_ahorrado`** (number): Tiempo ahorrado en minutos (calculado como `minutos_utilizados × 2.5`)
- **`minutos_utilizados`** (number): Minutos totales utilizados en llamadas durante el período

#### `agentes` (array)

Cada objeto contiene:

- **`nombre`** (string): Nombre del agente
- **`tipo`** (string): Tipo de agente (`"inbound"` o `"outbound"`)
- **`minutos_totales`** (number): Minutos totales utilizados por el agente
- **`estado`** (string): Estado del agente (`"activo"` o `"inactivo"`)

#### `llamadas_ultimos_7_dias` (array)

Cada objeto contiene:

- **`fecha`** (string): Fecha en formato `YYYY-MM-DD`
- **`total`** (number): Total de llamadas en ese día

---

## Códigos de Estado HTTP

| Código | Descripción                                                   |
| ------ | ------------------------------------------------------------- |
| `200`  | Solicitud exitosa                                             |
| `400`  | Error en la solicitud (credenciales no configuradas, etc.)    |
| `401`  | No autenticado (token inválido o faltante)                    |
| `404`  | Usuario no encontrado o configuración de Twilio no encontrada |

---

## Detalle de Origen de Datos

### ✅ Datos Reales (Obtenidos desde APIs/Servicios)

#### 1. **`resumen.total_llamadas`**

- **Origen**: Twilio API - Endpoint `/Calls.json`
- **Método**: Se obtienen todas las llamadas del período seleccionado y se cuenta el total
- **Datos utilizados**: Campo `calls.length` de la respuesta de Twilio
- **Nota**: Se maneja paginación automáticamente para obtener todas las llamadas

#### 2. **`resumen.minutos_utilizados`**

- **Origen**: Twilio API - Endpoint `/Calls.json`
- **Método**: Se suman todos los valores del campo `duration` de cada llamada
- **Datos utilizados**: Campo `duration` (en segundos) de cada llamada, convertido a minutos
- **Cálculo**: `suma de todas las duraciones en segundos / 60`

#### 3. **`llamadas_ultimos_7_dias`**

- **Origen**: Twilio API - Endpoint `/Calls.json`
- **Método**: Se obtienen todas las llamadas y se agrupan por fecha
- **Datos utilizados**: Campo `dateCreated` de cada llamada
- **Procesamiento**: Se filtran las llamadas por fecha y se cuenta el total por día
- **Nota**: Siempre muestra los últimos 7 días completos, independientemente del filtro `period`

#### 4. **`agentes.nombre`**

- **Origen**: Firestore - Colección `users`
- **Método**: Se obtiene el documento del usuario autenticado
- **Datos utilizados**: Campo `agent.name` del documento del usuario
- **Nota**: Solo se incluye el agente del usuario autenticado

#### 5. **`agentes.estado`**

- **Origen**: Firestore - Colección `users`
- **Método**: Se verifica si el usuario tiene configuración de Twilio
- **Lógica**:
  - `"activo"` si existe el campo `twilio` en el documento del usuario
  - `"inactivo"` si no existe el campo `twilio`
- **Datos utilizados**: Presencia del campo `twilio` en el documento del usuario

---

### ⚠️ Datos Mockeados/Calculados (No provienen directamente de APIs)

#### 1. **`resumen.tiempo_ahorrado`**

- **Origen**: Cálculo interno
- **Método**: Multiplicación de `minutos_utilizados` por un factor fijo
- **Fórmula**: `tiempo_ahorrado = minutos_utilizados × 2.5`
- **Factor utilizado**: `2.5` (configurado como constante `TIEMPO_AHORRO_FACTOR`)
- **Justificación**: Se asume que cada minuto de llamada con IA ahorra 2.5 minutos de trabajo manual
- **Nota**: Este factor puede ser configurado como variable de entorno en el futuro

#### 2. **`agentes.tipo`**

- **Origen**: Valor fijo
- **Valor actual**: Siempre `"inbound"`
- **Razón**: Por solicitud del cliente, todos los agentes se marcan como `"inbound"` temporalmente
- **Nota**: En el futuro, este valor podría determinarse analizando el campo `direction` de las llamadas de Twilio

#### 3. **`agentes.minutos_totales`**

- **Origen**: Cálculo interno (distribución)
- **Método**: Se asigna el mismo valor de `minutos_utilizados` del resumen a todos los agentes
- **Lógica**: `agentes.minutos_totales = resumen.minutos_utilizados`
- **Razón**: Por solicitud del cliente, todos los agentes reciben el mismo valor de minutos
- **Nota**: En el futuro, esto podría calcularse agrupando las llamadas por agente/usuario

---

## Flujo de Ejecución

1. **Autenticación**: Se valida el token de Firebase y se obtiene el `userId`
2. **Validación de Usuario**: Se verifica que el usuario exista en Firestore
3. **Validación de Twilio**: Se verifica que el usuario tenga configuración de Twilio (SID y Token)
4. **Cálculo de Rango de Fechas**: Se determina el rango de fechas según el parámetro `period`
5. **Obtención de Llamadas**: Se consulta la API de Twilio para obtener todas las llamadas del período
6. **Cálculo de Resumen**: Se calculan `total_llamadas`, `minutos_utilizados` y `tiempo_ahorrado`
7. **Obtención de Agentes**: Se obtiene la información del agente desde Firestore
8. **Cálculo de Últimos 7 Días**: Se agrupan las llamadas por fecha para los últimos 7 días
9. **Respuesta**: Se retorna el objeto completo con todas las métricas

---

## Ejemplo de Respuesta Completa

```json
{
  "resumen": {
    "total_llamadas": 150,
    "tiempo_ahorrado": 375,
    "minutos_utilizados": 150
  },
  "agentes": [
    {
      "nombre": "Ana García",
      "tipo": "inbound",
      "minutos_totales": 150,
      "estado": "activo"
    }
  ],
  "llamadas_ultimos_7_dias": [
    {
      "fecha": "2024-01-09",
      "total": 18
    },
    {
      "fecha": "2024-01-10",
      "total": 22
    },
    {
      "fecha": "2024-01-11",
      "total": 25
    },
    {
      "fecha": "2024-01-12",
      "total": 20
    },
    {
      "fecha": "2024-01-13",
      "total": 28
    },
    {
      "fecha": "2024-01-14",
      "total": 17
    },
    {
      "fecha": "2024-01-15",
      "total": 20
    }
  ]
}
```

---

## Manejo de Errores

### Usuario no encontrado

```json
{
  "statusCode": 404,
  "message": "Usuario no encontrado."
}
```

### Configuración de Twilio no encontrada

```json
{
  "statusCode": 404,
  "message": "Configuración de Twilio no encontrada para el usuario."
}
```

### Credenciales de Twilio no configuradas

```json
{
  "statusCode": 400,
  "message": "Credenciales de Twilio no configuradas."
}
```

### Error al obtener llamadas de Twilio

Si hay un error al consultar la API de Twilio, el endpoint retornará las llamadas que se hayan podido obtener hasta ese momento, o un array vacío si no se pudo obtener ninguna.

---

## Notas Técnicas

### Paginación de Twilio

El servicio maneja automáticamente la paginación de la API de Twilio. Si hay más de 1000 llamadas, se realizarán múltiples peticiones hasta obtener todas.

### Filtrado de Fechas

- El filtro `period` solo afecta al cálculo del `resumen`
- `llamadas_ultimos_7_dias` siempre muestra los últimos 7 días completos, independientemente del filtro
- Las fechas se calculan en tiempo UTC

### Factor de Tiempo Ahorrado

El factor `2.5` está definido como constante en el código. Para modificarlo, editar la constante `TIEMPO_AHORRO_FACTOR` en `src/metrics/metrics.service.ts`.

### Agentes

- Actualmente solo se incluye el agente del usuario autenticado
- Si el usuario no tiene configuración de agente, el array `agentes` estará vacío
- Todos los agentes reciben el mismo valor de `minutos_totales` (igual al total de minutos utilizados)

---

## Mejoras Futuras

1. **Cálculo real de minutos por agente**: Agrupar llamadas por agente/usuario
2. **Determinación automática del tipo de agente**: Analizar el campo `direction` de las llamadas
3. **Factor de tiempo ahorrado configurable**: Mover a variable de entorno
4. **Soporte para múltiples agentes**: Incluir todos los agentes asociados al usuario
5. **Caché de resultados**: Implementar caché para reducir llamadas a la API de Twilio
6. **Métricas adicionales**: Tiempo promedio de llamada, llamadas por hora, etc.

---

## Referencias

- [Twilio Calls API Documentation](https://www.twilio.com/docs/voice/api/call-resource)
- [Firebase Firestore Documentation](https://firebase.google.com/docs/firestore)
