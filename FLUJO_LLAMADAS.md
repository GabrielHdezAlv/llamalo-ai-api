# Flujo de Llamadas - LlamaloAI

## Resumen

Este documento describe el flujo completo de las llamadas en el sistema LlamaloAI, desde que Twilio recibe una llamada entrante hasta que se envía una respuesta de audio al usuario.

## Arquitectura General

```
Usuario → Twilio → NestJS Backend → Deepgram Voice Agent API → Twilio → Usuario
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
- **Responsabilidad**: Gestionar la comunicación bidireccional con Twilio durante la llamada y puentearla con Deepgram Voice Agent API.
- **Características**:
  - Gestión de sesiones por `callSid` (cada llamada tiene su propio estado).
  - Apertura y mantenimiento de un WebSocket dedicado contra `wss://agent.deepgram.com/v1/agent/converse`.
  - Encola audio μ-law entrante hasta que Deepgram confirma `SettingsApplied`.
  - Reenvía audio binario en ambos sentidos (Twilio ↔ Deepgram) y maneja keep-alives, warnings y errores.

### 3. **Deepgram Voice Agent API**
- Se consume directamente desde `StreamsGateway` (no hay servicios anidados).
- Deepgram se encarga de todo el pipeline (ASR + LLM + TTS) con latencias ~real-time.
- La configuración del agente (modelos, idioma, instrucciones, greetings) se envía mediante mensajes `Settings`, `InjectAgentMessage`, etc.

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
1. StreamsGateway recibe la conexión WebSocket de Twilio.
2. Espera el evento `start` para obtener `callSid`, `streamSid` y parámetros del agente.
3. Crea una sesión en memoria y abre un WebSocket dedicado contra Deepgram Voice Agent API.
4. Envía un mensaje `Settings` a Deepgram con:
   - Idioma y prompts del agente.
   - Configuración de audio (μ-law 8 kHz).
   - Modelos de `listen` y `speak`.
5. Cuando Deepgram responde con `SettingsApplied`, se habilita el envío de audio en tiempo real.
```

### Fase 3: Procesamiento en Deepgram (tiempo real)

```
Usuario habla:
1. Twilio envía chunks de audio en μ-law (base64)
2. StreamsGateway los reenvía como binario a Deepgram (sin convertir formato).
3. Deepgram procesa ASR + LLM + TTS dentro de la misma conexión.
4. Cuando el agente responde, Deepgram envía audio μ-law (binario) que StreamsGateway transforma a base64 y envía a Twilio.
5. Eventos relevantes:
   - `AgentStartedSpeaking` / `AgentAudioDone` permiten loggear el estado.
   - `Warning` y `Error` se reflejan en consola para su diagnóstico.
6. Opcionalmente se inyecta un saludo inicial mediante `InjectAgentMessage`.
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
  callSid: string;                   // ID único de la llamada de Twilio
  streamSid?: string;                // Stream asociado proporcionado por Twilio
  instructions: string;              // Prompt que se envía a Deepgram
  queuedAudio: Buffer[];             // Audio μ-law pendiente de envío
  readyForAudio: boolean;            // Deepgram confirmó SettingsApplied
  pendingGreeting?: string;          // Saludo a inyectar cuando aplica
  greetingSent: boolean;             // Bandera para evitar duplicados
  keepAliveTimer?: NodeJS.Timeout;   // Intervalo para mensajes KeepAlive
  voiceAgentSocket?: WebSocket;      // Conexión activa con Deepgram
}
```

## Variables de Entorno Importantes

### Deepgram Voice Agent
```env
DG_API_KEY=tu_api_key_deepgram
# Opcional: usar otra variable si se desea diferenciar claves
DG_VOICE_AGENT_API_KEY=tu_api_key_deepgram
DG_VOICE_AGENT_URL=wss://agent.deepgram.com/v1/agent/converse
DG_VOICE_AGENT_LANGUAGE=es
DG_LISTEN_MODEL=nova-3
DG_SPEAK_MODEL=aura-athena
DG_THINK_PROVIDER=deepgram        # Opcional (p.ej. deepgram, open_ai, anthropic)
DG_THINK_MODEL=flux-1             # Opcional, depende del provider
DG_THINK_TEMPERATURE=0.7
DG_AGENT_PROMPT=Eres un asistente de voz profesional...
DG_KEEPALIVE_MS=15000
DG_MAX_BUFFERED_CHUNKS=25
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

### Conexión con Deepgram falla
- Se registra el error y se cierra el WebSocket con Twilio para evitar estados inconsistentes.
- Revisar `DG_API_KEY`, firewall o `DG_VOICE_AGENT_URL`.

### Warning/Error emitido por Deepgram
- El evento llega como JSON (`type: "Warning"` o `type: "Error"`).
- Se loguea el código y la descripción para facilitar el soporte.
- Dependiendo de la severidad, la sesión puede continuar (warning) o cerrarse (error crítico).

### Audio no se reproduce
- Verificar que `streamSid` exista y que Twilio siga conectado.
- Confirmar que `SettingsApplied` apareció en los logs antes de comenzar a hablar.
- Revisar los eventos `AgentAudioDone` para descartar silencios prolongados.

## Mejoras Recientes (2024)

### Refactorización de StreamsGateway
1. **Eliminación de código duplicado**: Se removió la lógica duplicada entre `handleConnection` y `afterInit`
2. **Gestión de sesiones por llamada**: Cada llamada ahora tiene su propio estado independiente
3. **Callbacks únicos**: Los callbacks de ASR/TTS solo se registran una vez por sesión
4. **Integración directa con Deepgram**: Se reemplazó el pipeline Fish Audio + OpenAI por un único WebSocket contra Voice Agent API
5. **Keep-alive y control de warnings**: Se monitorean eventos `Warning`/`Error` y se envían `KeepAlive` periódicos

### Ventajas
- ✅ Soporte para múltiples llamadas simultáneas
- ✅ Menor uso de memoria
- ✅ Código más limpio y mantenible
- ✅ Mejor manejo de errores y trazabilidad de eventos Deepgram
- ✅ Menor latencia al eliminar hops intermedios

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

### "Deepgram rechazó la conexión"
- Revisar `DG_API_KEY` / `DG_VOICE_AGENT_API_KEY`
- Confirmar que el endpoint `DG_VOICE_AGENT_URL` esté accesible
- Verificar que no haya sido superada la cuota en Deepgram

### "Audio no se reproduce"
- Verificar que el audio de bienvenida esté correctamente configurado
- Validar en logs que `SettingsApplied` y `AgentAudioDone` aparezcan
- Revisar los logs de Twilio para encontrar posibles errores de media

### WebSocket no se conecta
- Verificar que el path sea exactamente `/voice/stream`
- Verificar que el servidor esté escuchando en el puerto correcto
- En producción, asegurarse de usar `wss://` en lugar de `ws://`

