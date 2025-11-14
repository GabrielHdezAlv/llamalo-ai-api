# Flujo de Llamadas - LlamaloAI

## Resumen

Este documento describe el flujo completo de las llamadas en el sistema LlamaloAI, desde que Twilio recibe una llamada entrante hasta que se envía una respuesta de audio al usuario.

## Arquitectura General

```
Usuario → Twilio → NestJS Backend → Fish Audio (ASR/TTS) + OpenAI (GPT) → Twilio → Usuario
```

## Componentes Principales

### 1. **CallsController** (`src/calls/calls.controller.ts`)
- **Endpoint**: `POST /voice/incoming`
- **Responsabilidad**: Recibir webhooks de Twilio cuando hay una llamada entrante
- **Flujo**:
  1. Busca el agente en Firestore por el número Twilio marcado
  2. Reproduce el audio de bienvenida (firstInteractionUrl o firstInteraction)
  3. Inicia un stream WebSocket hacia el backend
  4. Mantiene la llamada activa por 10 minutos

### 2. **StreamsGateway** (`src/streams/streams.gateway.ts`)
- **WebSocket Path**: `/voice/stream`
- **Responsabilidad**: Gestionar la comunicación bidireccional con Twilio durante la llamada
- **Características**:
  - Gestión de sesiones por `callSid` (cada llamada tiene su propio estado)
  - Soporte para modo WebSocket (tiempo real) y fallback HTTP
  - Transcripción de audio (ASR), generación de respuestas (GPT), síntesis de voz (TTS)

### 3. **Servicios de Fish Audio**

#### FishAsrService (ASR - Speech to Text en tiempo real)
- Conexión WebSocket con Fish Audio para transcripción en tiempo real
- Recibe audio PCM16 y devuelve transcripciones parciales y finales

#### FishTtsService (TTS - Text to Speech en tiempo real)
- Conexión WebSocket con Fish Audio para síntesis de voz en tiempo real
- Convierte texto a audio PCM16 en streaming

#### FishAsrHttpService (Fallback ASR)
- API HTTP para transcripción de audio
- Se usa cuando la conexión WebSocket falla

#### FishTtsHttpService (Fallback TTS)
- API HTTP para síntesis de voz
- Genera archivos MP3 completos y los sube a Firebase Storage

### 4. **GptService** (`src/llm/gpt.service.ts`)
- Integración con OpenAI GPT
- Genera respuestas en streaming basadas en la transcripción del usuario

## Flujo Detallado de una Llamada

### Fase 1: Inicio de la Llamada

```
1. Usuario llama al número Twilio del agente
2. Twilio envía webhook a POST /voice/incoming
3. Backend busca configuración del agente en Firestore
4. Backend genera TwiML con:
   - Audio de bienvenida
   - Instrucción de stream hacia WebSocket
5. Twilio inicia stream WebSocket a /voice/stream
```

### Fase 2: Establecimiento de Sesión WebSocket

```
1. StreamsGateway recibe conexión WebSocket
2. Intenta conectar ASR/TTS en modo WebSocket (tiempo real)
   - Si tiene éxito: useWebSocket = true
   - Si falla: useWebSocket = false (modo HTTP fallback)
3. Espera evento "start" de Twilio con el callSid
4. Crea sesión para esa llamada con:
   - callSid
   - estado (speaking/listening)
   - buffers de audio
   - cola HTTP (si aplica)
```

### Fase 3: Procesamiento de Audio (Modo WebSocket)

```
Usuario habla:
1. Twilio envía chunks de audio en μ-law (base64)
2. StreamsGateway convierte μ-law → PCM16
3. Envía PCM16 a FishAsrService (WebSocket)
4. Fish Audio devuelve transcripciones:
   - Parciales (is_final: false) → solo logging
   - Finales (is_final: true) → procesamiento completo

Cuando hay transcripción final:
5. Se envía el texto a GptService
6. GPT genera respuesta en streaming (palabra por palabra)
7. Cada 5 palabras o al finalizar oración:
   - Se envía el texto a FishTtsService (WebSocket)
   - Fish Audio genera audio PCM16
   - Se convierte PCM16 → μ-law
   - Se envía a Twilio para reproducción

Usuario escucha la respuesta del agente
```

### Fase 4: Procesamiento de Audio (Modo HTTP Fallback)

```
Usuario habla:
1. Twilio envía chunks de audio en μ-law (base64)
2. StreamsGateway convierte μ-law → PCM16
3. Acumula audio en buffer hasta:
   - Tener 1 segundo de audio (16000 bytes)
   - O timeout de 1 segundo
4. Envía buffer a FishAsrHttpService
5. Fish Audio devuelve transcripción completa

Cuando hay transcripción:
6. Se envía el texto a GptService
7. GPT genera respuesta completa (no streaming)
8. Se envía respuesta a FishTtsHttpService
9. Fish Audio genera audio MP3
10. Se sube MP3 a Firebase Storage
11. Se reproduce URL del MP3 con Twilio Call Media API

Usuario escucha la respuesta del agente
```

### Fase 5: Finalización de la Llamada

```
1. Usuario cuelga la llamada
2. Twilio envía evento "stop"
3. StreamsGateway:
   - Limpia la sesión (buffers, timers)
   - Detiene ASR/TTS
   - Cierra conexión WebSocket
4. Llamada terminada
```

## Gestión de Sesiones

Cada llamada tiene su propia sesión (`CallSession`) que incluye:

```typescript
interface CallSession {
  callSid: string;              // ID único de la llamada de Twilio
  speaking: boolean;            // ¿El agente está hablando?
  useWebSocket: boolean;        // Modo WebSocket o HTTP fallback
  audioBuffer: Buffer;          // Buffer para acumular audio (modo HTTP)
  audioBufferTimer?: NodeJS.Timeout;  // Timer para flush de buffer
  httpQueue: Promise<void>;     // Cola de procesamiento HTTP
  lastAsrTime: number;          // Timestamp de última transcripción (métricas)
}
```

## Variables de Entorno Importantes

### Fish Audio
```env
FISH_API_KEY=your_fish_audio_api_key
FISH_LANG=es-ES
FISH_TTS_VOICE_ID=your_voice_id
FISH_ASR_SAMPLE_RATE=8000
FISH_ASR_ENCODING=pcm16
FISH_TTS_AUDIO_FORMAT=mp3
```

### OpenAI
```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.7
```

### Twilio
```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
```

### Firebase
```env
FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com
```

### Configuración del Sistema
```env
ENABLE_AUTO_RESPONSE=true    # Habilitar respuestas automáticas
NODE_ENV=production          # Entorno (development/production)
```

## Métricas

El sistema recolecta métricas de latencia para:
- **ASR**: Tiempo entre transcripciones
- **GPT**: Tiempo hasta el primer token y tiempo total
- **TTS**: Tiempo de generación de audio

Las métricas se imprimen cada 30 segundos en consola con promedios y percentil 95.

## Manejo de Errores

### Conexión WebSocket Falla
- El sistema automáticamente cambia a modo HTTP fallback
- La llamada continúa funcionando pero con mayor latencia

### Error en Transcripción
- Se registra el error en consola
- La llamada continúa esperando el siguiente chunk de audio

### Error en GPT
- Se registra el error
- No se envía respuesta al usuario
- La llamada continúa esperando nueva entrada del usuario

### Error en TTS
- Se registra el error
- No se reproduce audio
- La llamada continúa esperando nueva entrada del usuario

## Mejoras Recientes (2024)

### Refactorización de StreamsGateway
1. **Eliminación de código duplicado**: Se removió la lógica duplicada entre `handleConnection` y `afterInit`
2. **Gestión de sesiones por llamada**: Cada llamada ahora tiene su propio estado independiente
3. **Callbacks únicos**: Los callbacks de ASR/TTS solo se registran una vez por sesión
4. **Mejor manejo de fallback HTTP**: El sistema ahora gestiona correctamente la cola de procesamiento HTTP

### Ventajas
- ✅ Soporte para múltiples llamadas simultáneas
- ✅ Menor uso de memoria
- ✅ Código más limpio y mantenible
- ✅ Mejor manejo de errores
- ✅ Fallback HTTP robusto

## Pruebas

Para probar el flujo completo:

1. Configurar todas las variables de entorno
2. Ejecutar el servidor: `npm run start:dev`
3. Exponer el servidor localmente (ngrok o similar)
4. Configurar el webhook de Twilio para apuntar a tu servidor
5. Llamar al número de Twilio asociado al agente
6. Verificar logs en consola para seguir el flujo

## Troubleshooting

### "No se encontró ningún agente con ese número"
- Verificar que el número Twilio esté correctamente configurado en Firestore
- El campo debe ser `twilio.phoneNumber` y debe ser un número entero

### "ASR/TTS conexión falló"
- Verificar que `FISH_API_KEY` esté configurado
- Verificar conectividad con Fish Audio API
- El sistema automáticamente usará HTTP fallback

### "Audio no se reproduce"
- Verificar que el audio de bienvenida esté correctamente configurado
- Para modo HTTP: verificar que Firebase Storage esté correctamente configurado
- Verificar logs de Twilio para errores en la reproducción

### WebSocket no se conecta
- Verificar que el path sea exactamente `/voice/stream`
- Verificar que el servidor esté escuchando en el puerto correcto
- En producción, asegurarse de usar `wss://` en lugar de `ws://`

