# Métricas Detalladas de Twilio

## Endpoint

**`GET /metrics/twilio-detailed`**

## Descripción

Este endpoint proporciona métricas avanzadas y detalladas de Twilio para análisis comprehensivo del rendimiento de las llamadas. Incluye estadísticas de éxito, patrones de uso, distribución geográfica y análisis de finalización.

## Autenticación

- **Requerida**: Bearer Token (Firebase Auth)
- **Usuario**: Se obtiene automáticamente del token JWT

## Parámetros

### Query Parameters (Opcional)

| Parámetro         | Tipo   | Requerido | Descripción                                                                                                             | Ejemplo    |
| ----------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| `twilioAccountId` | number | No        | ID de la cuenta de Twilio para obtener métricas específicas. Si no se especifica, se usa la primera cuenta configurada. | 1234567890 |

## Response

### Estructura del Response

```typescript
{
  llamadasExitosasUltimos7Dias: [
    { fecha: "2026-02-01", total: 15 },
    { fecha: "2026-02-02", total: 23 },
    // ... últimos 7 días
  ],
  totalMinutosUltimoMes: 1250,
  duracionMediaLlamadas: 4.5,
  tiposLlamadas: {
    inbound: 75,    // 75%
    outbound: 25    // 25%
  },
  paisesOrigen: [
    { pais: "ES", cantidad: 45 },
    { pais: "MX", cantidad: 12 },
    { pais: "AR", cantidad: 8 }
  ],
  evaluacionExito: {
    exitosas: 85,    // 85%
    parciales: 10,   // 10%
    fallidas: 5      // 5%
  },
  razonesFinalizacion: {
    completada: 80,      // 80%
    clienteColgo: 15,    // 15%
    errorTecnico: 3,     // 3%
    tiempoAgotado: 2     // 2%
  }
}
```

### Detalle de Campos

#### `llamadasExitosasUltimos7Dias`

- **Descripción**: Llamadas exitosas (status: 'completed') de los últimos 7 días divididas por día
- **Tipo**: Array de objetos
- **Formato**: `{ fecha: "YYYY-MM-DD", total: number }`

#### `totalMinutosUltimoMes`

- **Descripción**: Total de minutos consumidos en el mes actual (día 1 al último día)
- **Tipo**: number
- **Fuente**: Twilio Usage Records API (inbound + outbound)

#### `duracionMediaLlamadas`

- **Descripción**: Duración promedio de todas las llamadas en minutos
- **Tipo**: number
- **Precisión**: 1 decimal
- **Período**: Últimos 90 días

#### `tiposLlamadas`

- **Descripción**: Distribución porcentual de tipos de llamadas
- **Tipo**: objeto
- **Campos**:
  - `inbound`: porcentaje de llamadas entrantes
  - `outbound`: porcentaje de llamadas salientes

#### `paisesOrigen`

- **Descripción**: Top 10 países de donde provienen las llamadas
- **Tipo**: Array de objetos
- **Formato**: `{ pais: "Código ISO o 'SIN IDENTIFICAR'", cantidad: number, porcentaje: number }`
- **Orden**: Descendente por cantidad
- **Campos**:
  - `pais`: Código de país numérico o "SIN IDENTIFICAR" para números ocultos
  - `cantidad`: Número absoluto de llamadas
  - `porcentaje`: Porcentaje del total con 1 decimal

#### `evaluacionExito`

- **Descripción**: Evaluación porcentual del éxito de las llamadas
- **Tipo**: objeto
- **Categorías**:
  - `exitosas`: llamadas completadas con éxito (completed)
  - `parciales`: llamadas contestadas o en progreso (answered, in-progress)
  - `fallidas`: llamadas fallidas (failed, busy, no-answer, canceled)

#### `razonesFinalizacion`

- **Descripción**: Razones de finalización de las llamadas
- **Tipo**: objeto
- **Categorías**:
  - `completada`: completada con éxito (completed)
  - `clienteColgo`: cliente colgó o no respondió (no-answer, canceled)
  - `errorTecnico`: error técnico (failed)
  - `tiempoAgotado`: tiempo agotado (busy)

## Ejemplos de Uso

### Obtener métricas de la cuenta por defecto

```bash
curl -X GET "https://api.example.com/metrics/twilio-detailed" \
  -H "Authorization: Bearer <firebase_token>"
```

### Obtener métricas de una cuenta específica

```bash
curl -X GET "https://api.example.com/metrics/twilio-detailed?twilioAccountId=1234567890" \
  -H "Authorization: Bearer <firebase_token>"
```

### Response de ejemplo

```json
{
  "llamadasExitosasUltimos7Dias": [
    { "fecha": "2026-02-01", "total": 15 },
    { "fecha": "2026-02-02", "total": 23 },
    { "fecha": "2026-02-03", "total": 18 },
    { "fecha": "2026-02-04", "total": 31 },
    { "fecha": "2026-02-05", "total": 27 },
    { "fecha": "2026-02-06", "total": 22 },
    { "fecha": "2026-02-07", "total": 19 }
  ],
  "totalMinutosUltimoMes": 1250,
  "duracionMediaLlamadas": 4.5,
  "tiposLlamadas": {
    "inbound": 75,
    "outbound": 25
  },
  "paisesOrigen": [
    { "pais": "34", "cantidad": 45, "porcentaje": 65.2 },
    { "pais": "52", "cantidad": 12, "porcentaje": 17.4 },
    { "pais": "SIN IDENTIFICAR", "cantidad": 8, "porcentaje": 11.6 },
    { "pais": "54", "cantidad": 6, "porcentaje": 8.7 }
  ],
  "evaluacionExito": {
    "exitosas": 85,
    "parciales": 10,
    "fallidas": 5
  },
  "razonesFinalizacion": {
    "completada": 80,
    "clienteColgo": 15,
    "errorTecnico": 3,
    "tiempoAgotado": 2
  }
}
```

## Códigos de Estado

| Código | Descripción                                          |
| ------ | ---------------------------------------------------- |
| 200    | Métricas obtenidas exitosamente                      |
| 400    | Bad Request - Parámetros inválidos                   |
| 401    | Unauthorized - Token inválido o expirado             |
| 404    | Not Found - Usuario o cuenta de Twilio no encontrada |
| 500    | Internal Server Error - Error del servidor           |

## Consideraciones Técnicas

### Periodos de Tiempo

- **Últimos 7 días**: Para llamadas exitosas diarias
- **Mes actual**: Para minutos consumidos (día 1 al último día)
- **Últimos 90 días**: Para análisis generales (duración media, países, etc.)

### Rendimiento

- El endpoint realiza múltiples llamadas a la API de Twilio en paralelo
- Se implementa paginación automática para manejar grandes volúmenes de llamadas
- Los cálculos se realizan en el servidor para minimizar transferencia de datos

### Límites y Cuotas

- Sujeto a los límites de la API de Twilio
- Para cuentas con alto volumen de llamadas, el response time puede ser mayor
- Se recomienda cachear los resultados para consultas frecuentes

## Errores Comunes

### Cuenta no encontrada

```json
{
  "message": "Cuenta de Twilio con ID 1234567890 no encontrada.",
  "error": "Not Found",
  "statusCode": 404
}
```

### Sin credenciales configuradas

```json
{
  "message": "Configuración de Twilio no encontrada para el usuario.",
  "error": "Not Found",
  "statusCode": 404
}
```

### Error de API de Twilio

```json
{
  "message": "Error al obtener las métricas detalladas de Twilio: [Error message]",
  "error": "Bad Request",
  "statusCode": 400
}
```
