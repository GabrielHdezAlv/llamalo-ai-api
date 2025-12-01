# Flujo Completo de una Llamada - LlamaloAI

## Resumen Ejecutivo

Este documento describe el flujo completo de una llamada telefónica desde que Twilio recibe la llamada hasta que se procesa mediante Google Cloud services (Speech-to-Text, Gemini AI, Text-to-Speech) y se devuelve la respuesta al usuario.

## Arquitectura General

```
Usuario → Twilio → WebSocket → Backend NestJS → Google Cloud Services → Twilio → Usuario
```

### Componentes Principales

1. **Twilio**: Servicio de telefonía que maneja las llamadas entrantes
2. **CallsController**: Endpoint REST que recibe webhooks de Twilio y genera TwiML
3. **StreamsGateway**: Gateway WebSocket que maneja el streaming de audio en tiempo real
4. **Google Cloud Speech-to-Text**: Convierte audio a texto
5. **Gemini AI**: Procesa el texto y genera respuestas conversacionales
6. **Google Cloud Text-to-Speech**: Convierte texto a audio

---

## Flujo Detallado Paso a Paso

### 1. Llamada Entrante a Twilio

**Endpoint**: `POST /voice/incoming`

**Proceso**:
- Twilio recibe una llamada entrante
- Twilio hace un POST al endpoint `/voice/incoming` con:
  - `To`: Número marcado (número del agente)
  - `From`: Número del cliente
  - `CallSid`: Identificador único de la llamada

**Logs**:
```
📞 Llamada entrante detectada
➡️ Número marcado (To): +34822272090
➡️ Número del cliente (From): anonymous
```

---

### 2. Búsqueda del Agente en Firestore

**Proceso**:
- El backend extrae el número de teléfono del campo `To` (eliminando el prefijo `+34` y caracteres no numéricos)
- Busca en Firestore (`users` collection) un agente con `twilio.phoneNumber` coincidente
- Si no encuentra el agente, devuelve un mensaje de error en TwiML

**Código**:
```typescript
const rawNumber = body.To?.replace('+34', '').replace(/\D/g, '');
const agentNumber = parseInt(rawNumber || '0', 10);
const agentSnapshot = await firestore
  .collection('users')
  .where('twilio.phoneNumber', '==', agentNumber)
  .limit(1)
  .get();
```

**Logs**:
```
🔍 Buscando agente con twilio.phoneNumber: 822272090
```

---

### 3. Generación de TwiML

**Proceso**:
- Si se encuentra el agente, se genera un TwiML que:
  - Conecta la llamada a un WebSocket en `/voice/stream`
  - Configura el track como `inbound_track` (solo audio entrante)
  - Añade parámetros personalizados:
    - `agentName`: Nombre del agente
    - `greeting`: Saludo personalizado (texto)
    - `greetingUrl`: URL de saludo personalizado (audio) - **Nota**: Actualmente no se usa
    - `instructions`: Instrucciones del agente (hasta 50,000 caracteres)

**TwiML Generado**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://llamaloiabackend-5294.onrender.com/voice/stream" track="inbound_track">
      <Parameter name="agentName" value="Carlos"/>
      <Parameter name="greeting" value="Hola, bienvenido a LlamaloAI..."/>
      <Parameter name="instructions" value="INSTRUCCIONES OFICIALES..."/>
    </Stream>
  </Connect>
</Response>
```

**Logs**:
```
🔗 WebSocket URL: wss://llamaloiabackend-5294.onrender.com/voice/stream
📄 TwiML generado: <?xml...>
✅ TwiML generado correctamente.
```

---

### 4. Conexión WebSocket

**Proceso**:
- Twilio se conecta al WebSocket en `/voice/stream`
- El servidor WebSocket (configurado en `main.ts`) acepta la conexión
- Se crea un buffer para almacenar mensajes tempranos (antes de que se registre el handler)

**Logs**:
```
🛰️ Nueva conexión WebSocket establecida
📡 Cliente conectado desde: 10.17.216.130
🌐 URL: /voice/stream
```

---

### 5. Eventos de Twilio

Twilio envía varios eventos a través del WebSocket:

#### 5.1. Evento `connected`
- Se envía al inicio de la conexión
- El backend lo ignora (no requiere procesamiento)

#### 5.2. Evento `start`
- Contiene información de la llamada:
  - `callSid`: Identificador único de la llamada
  - `streamSid`: Identificador del stream
  - `accountSid`: Identificador de la cuenta Twilio
  - `customParameters`: Parámetros personalizados (agentName, greeting, instructions)
  - `mediaFormat`: Formato del audio (MULAW, 8kHz)

**Proceso**:
- Se extrae el `callSid`
- Se crea una nueva sesión llamando a `createSession()`

**Logs**:
```
📞 [CAfd4e3bc3184934183e187ad7c24c67be] Llamada iniciada
```

#### 5.3. Evento `media`
- Contiene chunks de audio en formato base64
- Se envía continuamente mientras hay audio
- Formato: MULAW, 8kHz, 20ms por chunk

**Estructura**:
```json
{
  "event": "media",
  "media": {
    "payload": "base64_encoded_audio",
    "track": "inbound_track",
    "chunk": "1",
    "timestamp": "1234567890"
  },
  "streamSid": "MZ..."
}
```

#### 5.4. Evento `stop`
- Se envía cuando la llamada termina
- El backend limpia la sesión y cierra la conexión

**Logs**:
```
🛑 [CAfd4e3bc3184934183e187ad7c24c67be] Llamada terminada
```

---

### 6. Creación de Sesión

**Método**: `createSession()`

**Proceso**:
1. Verifica si ya existe una sesión para el `callSid` y la limpia si existe
2. Extrae parámetros personalizados del evento `start`
3. Resuelve las instrucciones del agente:
   - Si hay `customParameters.instructions`, las usa
   - Si no, usa `defaultInstructions` (variable de entorno o valor por defecto)
4. Resuelve el saludo (greeting) del agente
5. Crea un objeto `CallSession` con:
   - `callSid`, `streamSid`, `client`
   - `customParameters`, `instructions`
   - `queuedAudio`: Buffer para audio recibido antes de inicializar servicios
   - `readyForAudio`: Flag para indicar si los servicios están listos
   - `pendingGreeting`: Saludo pendiente de enviar
   - `conversationHistory`: Historial de conversación para Gemini
   - `agentSpeaking`, `interrupted`: Flags para manejo de barge-in
6. Almacena la sesión en `this.sessions` (Map)
7. Inicializa servicios de Google Cloud

**Logs**:
```
📋 [CAfd4e3bc3184934183e187ad7c24c67be] AgentInstruction recibido desde Twilio: "..."
🧠 [CAfd4e3bc3184934183e187ad7c24c67be] Session.instructions configurado: "..."
```

---

### 7. Inicialización de Servicios de Google Cloud

**Método**: `initializeGoogleServices()`

**Proceso**:
1. **Inicializa Gemini** (`connectToGemini()`):
   - Crea instancia de `GoogleGenerativeAI` con API key
   - Obtiene el modelo (por defecto: `gemini-1.5-flash`)
   - Configura temperatura (por defecto: 0.7)
   - Inicializa el historial de conversación con las instrucciones del agente

2. **Inicializa Speech-to-Text** (`connectToGoogleSTT()`):
   - Crea un stream de reconocimiento con configuración:
     - Encoding: `MULAW`
     - Sample Rate: `8000 Hz`
     - Language: `es-ES`
     - Model: `latest_long`
     - `interimResults: true` (para detectar interrupciones)
   - Registra handlers para `error` y `data`

3. **Marca sesión como lista** (`readyForAudio = true`)

4. **Procesa audio en cola** (`flushQueuedAudio()`):
   - Si llegó audio antes de inicializar servicios, lo procesa ahora

5. **Envía saludo pendiente** (`maybeSendPendingGreeting()`):
   - Si hay un `pendingGreeting`, lo convierte a audio y lo envía

**Logs**:
```
✅ [CAfd4e3bc3184934183e187ad7c24c67be] Cliente Gemini inicializado
✅ [CAfd4e3bc3184934183e187ad7c24c67be] Speech-to-Text streaming iniciado
⚙️ [CAfd4e3bc3184934183e187ad7c24c67be] Servicios de Google Cloud inicializados
```

---

### 8. Procesamiento de Audio Entrante

**Método**: `forwardInboundAudio()`

**Proceso**:
1. Obtiene la sesión por `callSid`
2. Decodifica el payload base64 del evento `media`
3. Si los servicios no están listos (`!readyForAudio`):
   - Almacena el audio en `queuedAudio` para procesarlo después
4. Si los servicios están listos:
   - Envía el audio a Google Speech-to-Text (`sendAudioChunkToGoogleSTT()`)

**Método**: `sendAudioChunkToGoogleSTT()`
- Convierte el buffer a formato compatible
- Escribe el chunk en el stream de Speech-to-Text

---

### 9. Reconocimiento de Voz (Speech-to-Text)

**Proceso**:
- Google Cloud Speech-to-Text procesa el audio en streaming
- Cuando detecta una transcripción (resultado final o con alta estabilidad), emite un evento `data`
- El handler `handleSTTResult()` procesa el resultado

**Método**: `handleSTTResult()`

**Proceso**:
1. Extrae el transcript del resultado
2. Verifica si es resultado final (`isFinalTranscript` o `stability > 0.9`)
3. Si es resultado final:
   - **Detección de Barge-in**: Si `agentSpeaking === true`, marca `interrupted = true`
   - Añade el mensaje del usuario al historial de conversación
   - Marca `userSpeakingStartTime` para calcular latencia
   - Llama a `processWithGemini()` para generar respuesta

**Logs**:
```
👤 [CAfd4e3bc3184934183e187ad7c24c67be] Usuario dijo: "Hola, necesito ayuda"
🛑 [CAfd4e3bc3184934183e187ad7c24c67be] Usuario interrumpió al agente  // Si hubo interrupción
```

---

### 10. Procesamiento con Gemini AI

**Método**: `processWithGemini()`

**Proceso**:
1. Crea un chat con Gemini usando el historial de conversación
2. Obtiene el último mensaje del usuario
3. Genera respuesta en streaming usando `sendMessageStream()`
4. Para cada chunk de texto recibido:
   - Si hay interrupción (`session.interrupted`), detiene el procesamiento
   - Acumula el texto completo
   - Convierte el chunk a audio en tiempo real (`streamTTSChunk()`)
5. Si no hubo interrupción:
   - Añade la respuesta completa al historial de conversación
   - Calcula latencia (tiempo desde que el usuario habló hasta que el agente terminó)
6. Marca `agentSpeaking = false`

**Logs**:
```
🗣️ [CAfd4e3bc3184934183e187ad7c24c67be] Agente respondió (latencia: 1234ms, promedio: 1200ms)
✅ [CAfd4e3bc3184934183e187ad7c24c67be] Agente terminó de hablar
```

---

### 11. Conversión de Texto a Audio (Text-to-Speech)

**Método**: `streamTTSChunk()`

**Proceso**:
1. Verifica que no haya interrupción y que el texto no esté vacío
2. Crea una solicitud a Google Cloud Text-to-Speech:
   - `input.text`: Texto a convertir
   - `voice`: Voz configurada (por defecto: `es-ES-Neural2-D`)
   - `audioConfig`: Encoding MULAW, 8kHz
3. Llama a `synthesizeSpeech()`
4. Convierte el audio recibido a Buffer
5. Envía el audio a Twilio (`relayAudioToTwilio()`)

**Nota**: Google Cloud TTS no tiene streaming nativo, por lo que cada chunk de texto se convierte a audio individualmente. Esto puede aumentar la latencia comparado con servicios que tienen streaming nativo.

---

### 12. Envío de Audio a Twilio

**Método**: `relayAudioToTwilio()`

**Proceso**:
1. Verifica que no haya interrupción activa
2. Crea un mensaje JSON para Twilio:
   ```json
   {
     "event": "media",
     "streamSid": "MZ...",
     "media": {
       "payload": "base64_encoded_audio"
     }
   }
   ```
3. Codifica el audio en base64
4. Envía el mensaje a través del WebSocket

**Nota**: Si hay una interrupción activa, el audio no se envía (barge-in).

---

### 13. Manejo de Barge-in (Interrupciones)

**Proceso**:
- Cuando el usuario habla mientras el agente está hablando:
  1. `handleSTTResult()` detecta el nuevo transcript
  2. Marca `session.interrupted = true` y `session.agentSpeaking = false`
  3. El loop de streaming de Gemini verifica `session.interrupted` y se detiene
  4. `streamTTSChunk()` verifica `session.interrupted` antes de enviar audio
  5. `relayAudioToTwilio()` verifica `session.interrupted` antes de enviar audio
  6. Se procesa la nueva entrada del usuario inmediatamente

**Logs**:
```
🛑 [CAfd4e3bc3184934183e187ad7c24c67be] Usuario interrumpió al agente
```

---

### 14. Saludo Inicial

**Método**: `maybeSendPendingGreeting()`

**Proceso**:
- Si hay un `pendingGreeting` y aún no se ha enviado:
  1. Convierte el texto del saludo a audio usando TTS
  2. Envía el audio a Twilio
  3. Marca `greetingSent = true`

**Nota**: El saludo se envía después de inicializar los servicios, no inmediatamente al crear la sesión.

---

### 15. Limpieza de Sesión

**Método**: `cleanupSession()`

**Proceso**:
- Se ejecuta cuando:
  - Llega el evento `stop` de Twilio
  - Se cierra la conexión WebSocket
  - Se crea una nueva sesión para el mismo `callSid`

**Acciones**:
1. Cierra el stream de Speech-to-Text si existe
2. Limpia referencias a clientes de Google Cloud
3. Calcula y muestra métricas de latencia promedio
4. Elimina la sesión del Map `this.sessions`

**Logs**:
```
🔌 [CAfd4e3bc3184934183e187ad7c24c67be] Conexión cerrada
```

---

## Diagrama de Flujo

```
┌─────────┐
│ Usuario │
└────┬────┘
     │ Llamada
     ▼
┌─────────┐
│ Twilio  │
└────┬────┘
     │ POST /voice/incoming
     ▼
┌─────────────────┐
│ CallsController │
│ - Busca agente  │
│ - Genera TwiML  │
└────┬────────────┘
     │ TwiML con WebSocket URL
     ▼
┌─────────┐
│ Twilio  │
└────┬────┘
     │ WebSocket Connect
     ▼
┌─────────────────┐
│ StreamsGateway  │
│ - Crea sesión   │
│ - Inicializa GC │
└────┬────────────┘
     │
     ├──► Google STT ──► Transcripción ──► Gemini AI ──► Respuesta ──► Google TTS ──► Audio ──► Twilio ──► Usuario
     │
     └──► Audio chunks ──► Google STT
```

---

## Formato de Audio

- **Encoding**: MULAW (μ-law)
- **Sample Rate**: 8000 Hz
- **Chunk Size**: ~20ms por chunk
- **Formato de transmisión**: Base64 en JSON

---

## Variables de Entorno Necesarias

```env
# Google Cloud
GEMINI_API_KEY=tu_api_key
GOOGLE_CLOUD_PROJECT_ID=tu-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json  # Opcional
GOOGLE_TTS_VOICE_NAME=es-ES-Neural2-D  # Opcional

# Gemini
GEMINI_MODEL=gemini-1.5-flash  # Opcional
GEMINI_TEMPERATURE=0.7  # Opcional
GEMINI_AGENT_PROMPT=...  # Opcional

# Buffering
MAX_BUFFERED_CHUNKS=25  # Opcional
```

---

## Consideraciones Técnicas

### Latencia
- La orquestación de 3 servicios (STT → Gemini → TTS) puede aumentar la latencia
- Google Cloud TTS no tiene streaming nativo, lo que añade latencia adicional
- Se calcula y registra la latencia promedio por llamada

### Barge-in
- Implementación manual mediante detección de transcripciones mientras `agentSpeaking === true`
- No es tan inmediato como servicios con barge-in nativo, pero funciona correctamente

### Escalabilidad
- Cada llamada mantiene su propia sesión con clientes de Google Cloud
- Las sesiones se limpian automáticamente al terminar la llamada
- No hay límite de llamadas concurrentes (depende de recursos del servidor)

### Manejo de Errores
- Errores en STT, Gemini o TTS se registran pero no terminan la llamada
- Si falla la inicialización de servicios, la llamada puede continuar pero sin procesamiento
- Los errores de conexión WebSocket terminan la llamada

---

## Logs Importantes

### Inicio de Llamada
```
📞 [CallSid] Llamada iniciada
✅ [CallSid] Cliente Gemini inicializado
✅ [CallSid] Speech-to-Text streaming iniciado
⚙️ [CallSid] Servicios de Google Cloud inicializados
```

### Conversación
```
👤 [CallSid] Usuario dijo: "..."
🛑 [CallSid] Usuario interrumpió al agente  // Si aplica
🗣️ [CallSid] Agente respondió (latencia: Xms, promedio: Yms)
✅ [CallSid] Agente terminó de hablar
```

### Fin de Llamada
```
🛑 [CallSid] Llamada terminada
🔌 [CallSid] Conexión cerrada
```

---

## Mejoras Futuras

1. **Streaming nativo de TTS**: Investigar alternativas con streaming nativo para reducir latencia
2. **Barge-in más rápido**: Usar resultados intermedios de STT para detectar interrupciones más rápido
3. **Caché de TTS**: Cachear respuestas comunes para reducir llamadas a TTS
4. **Métricas avanzadas**: Añadir más métricas (tiempo de respuesta por servicio, tasa de interrupciones, etc.)
5. **Manejo de errores mejorado**: Reintentos automáticos y fallbacks

---

## Referencias

- [Twilio Media Streams](https://www.twilio.com/docs/voice/twiml/stream)
- [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text/docs)
- [Gemini API](https://ai.google.dev/docs)
- [Google Cloud Text-to-Speech](https://cloud.google.com/text-to-speech/docs)

