# Flujo de Llamada Actual (Twilio → StreamsGateway → STT/LLM/TTS)

## Resumen

- Entrante por webhook `POST /voice/incoming`.
- Se busca el agente en Firestore y se genera TwiML que abre un WebSocket a `/voice/stream` con parámetros del agente.
- Audio μ-law (8 kHz) de Twilio → STT Deepgram (único proveedor).
- Texto → LLM (OpenAI Chat completions) con prompt del agente.
- Respuesta → TTS ElevenLabs → Twilio → usuario. Barge-in cancela TTS en curso.
- Saludo inicial: `firstInteraction` del agente se sintetiza con ElevenLabs TTS al iniciar la sesión, sin `greetingUrl` ni injects.
- Sesión se limpia en `stop` o cierre de WS.

## Arquitectura (alto nivel)

```
Usuario → Twilio (Voice) → POST /voice/incoming → TwiML (Stream)
Twilio ↔ WS /voice/stream (StreamsGateway)
  - STT: Deepgram Voice Agent (listen/speak/think)
  - LLM: OpenAI (modelo configurable)
  - TTS: ElevenLabs (ulaw_8000)
Audio TTS → Twilio → Usuario
```

## Endpoints y rutas

- HTTP: `POST /voice/incoming` (TwiML inicial), `POST /voice/resume` (reconexión de stream).
- WebSocket: `/voice/stream` (Twilio ↔ StreamsGateway).
- Upstreams externos:
  - Deepgram Voice Agent (STT/LLM listen-speak-think): `wss://agent.deepgram.com/v1/agent/converse`
  - ElevenLabs TTS: `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream`
  - OpenAI Chat Completions (modelo `OPENAI_MODEL`, por defecto `gpt-4o-mini`)

## Flujo paso a paso

1. **Webhook entrante (`/voice/incoming`)**
   - Twilio envía `To`, `From`, `CallSid`.
   - Se busca en Firestore `users.twilio.phoneNumber == To` (sin `+34` ni no numérico).
   - Si no hay agente: `say` con error y finaliza.
   - Si hay agente: se construye TwiML `<Stream>` hacia `/voice/stream` con `track="inbound_track"` y parámetros:
     - `agentName`, `greeting` (texto), `greetingUrl`, `instructions` (hasta 50k chars), `labsId` (voz ElevenLabs), `language` (código idioma).

2. **Conexión WS Twilio → `/voice/stream`**
   - `StreamsGateway` crea `CallSession` por `callSid`, guarda `streamSid`, parámetros, instrucciones, voz y idioma.
   - Proveedor STT único: Deepgram (`STT_PROVIDER=deepgram` por defecto y fijo).
   - Si hay `greeting`/`firstInteraction`, se marca como pendiente para sintetizar con ElevenLabs TTS cuando Deepgram esté listo.

3. **Inicio STT**
   - Deepgram: abre WS y envía `Settings` (idioma, modelos listen/speak, think); espera `SettingsApplied` para marcar `readyForAudio=true` y drenar audio.
   - Saludo inicial: al estar listo Deepgram, se sintetiza el `greeting` (firstInteraction) con ElevenLabs TTS y se envía a Twilio (sin `greetingUrl` ni `InjectAgentMessage`).

4. **Audio entrante**
   - Twilio envía eventos `media` (μ-law base64). Si `readyForAudio=false`, se encola hasta `maxBufferedChunks`.
   - Al estar listo, cada chunk se reenvía a Deepgram.
   - Si el agente está hablando y entra audio, se marca `interrupted=true` y se cancela TTS en curso (barge-in).

5. **Transcripción y LLM**
   - STT final → `handleFinalTranscript`: agrega mensaje de usuario al historial y llama a OpenAI Chat (`OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_TOKENS`) con `system: instructions` + historial.
   - Respuesta del LLM se marca `agentSpeaking=true` y se pasa a TTS.

6. **TTS y envío a Twilio**
   - Siempre ElevenLabs TTS (voz `labsId` o `ELEVENLABS_TTS_VOICE_ID`, `output_format=ulaw_8000` o conversión desde `pcm_16000`): se streamean chunks al WS de Twilio como `media` outbound (base64).
   - El saludo inicial y todas las respuestas del LLM se sintetizan por aquí.
   - Si `interrupted`, no se envían más chunks y se destruye el stream TTS.

7. **Eventos clave**
   - `connected`: ignorado.
   - `start`: crea sesión.
   - `media`: audio entrante → STT.
   - `stop` o cierre WS: `cleanupSession` (cierra sockets STT/Deepgram, timers keep-alive, cancela TTS, borra sesión).

## Configuraciones y proveedores

- **STT**: Deepgram Voice Agent (listen/speak/think) como único proveedor.
- **TTS**: Siempre ElevenLabs; soporta `ulaw_8000` nativo o conversión desde `pcm_16000`.
- **LLM**: OpenAI Chat completions (`OPENAI_MODEL`, default `gpt-4o-mini`).
- **Barge-in**: detección de transcripción mientras `agentSpeaking=true` → `interrupted=true` → cancela TTS y prioriza nueva entrada de usuario.
- **Greeting**: `greeting`/`firstInteraction` se sintetiza con ElevenLabs TTS al arrancar Deepgram; sin `greetingUrl` ni mensajes injectados.

## Variables de entorno principales

- Routing: `NODE_ENV` (elige WS público vs local), `STT_PROVIDER`, `TTS_PROVIDER`.
- Deepgram (requerido): `DG_VOICE_AGENT_API_KEY`/`DG_API_KEY`, `DG_VOICE_AGENT_URL`, `DG_VOICE_AGENT_LANGUAGE`, `DG_LISTEN_PROVIDER`, `DG_LISTEN_MODEL`, `DG_SPEAK_PROVIDER`, `DG_SPEAK_MODEL`, `DG_THINK_PROVIDER`, `DG_THINK_MODEL`, `DG_THINK_TEMPERATURE`, `DG_KEEPALIVE_MS`, `DG_MAX_BUFFERED_CHUNKS`, `DG_AGENT_PROMPT`.
- ElevenLabs (solo TTS): `ELEVENLABS_API_KEY`, `ELEVENLABS_LANGUAGE`, `ELEVENLABS_TTS_VOICE_ID`, `ELEVENLABS_TTS_MODEL_ID`, `ELEVENLABS_TTS_OUTPUT_FORMAT` (`ulaw_8000`|`pcm_16000`), `ELEVENLABS_TTS_STABILITY`, `ELEVENLABS_TTS_STYLE`, `ELEVENLABS_TTS_SIMILARITY`, `ELEVENLABS_TTS_SPEAKER_BOOST`, `ELEVENLABS_TTS_VOICE_SPEED`.
- LLM: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_TOKENS`.

## Logs útiles (esperados)

- Inicio: `📞 [callSid] Llamada iniciada`, `🔌 STT ElevenLabs conectado` o `⚙️ Deepgram listo`.
- STT: `✏️ Parcial STT`, `📝 Transcripción final`.
- LLM: `💬 Respuesta LLM: ...`
- TTS: `🎵 Iniciando TTS...`, `📦 Chunk recibido...`, `✅ Stream ElevenLabs TTS terminado`.
- Barge-in: `🛑 Usuario interrumpió al agente`.
- Fin: `🛑 Llamada terminada`, `🧹 Limpiando sesión`.
