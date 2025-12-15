# Flujo de Llamada Actual (Twilio → StreamsGateway → STT/LLM/TTS)

## Resumen

- Entrante por webhook `POST /voice/incoming`.
- Se busca el agente en Firestore y se genera TwiML que abre un WebSocket a `/voice/stream` con parámetros del agente.
- Audio μ-law (8 kHz) de Twilio → STT (ElevenLabs por defecto, fallback Deepgram).
- Texto → LLM (OpenAI Chat completions) con prompt del agente.
- Respuesta → TTS ElevenLabs → Twilio → usuario. Barge-in cancela TTS en curso.
- Sesión se limpia en `stop` o cierre de WS.

## Arquitectura (alto nivel)

```
Usuario → Twilio (Voice) → POST /voice/incoming → TwiML (Stream)
Twilio ↔ WS /voice/stream (StreamsGateway)
  - STT: ElevenLabs (ulaw 8k) | fallback Deepgram Voice Agent
  - LLM: OpenAI (modelo configurable)
  - TTS: ElevenLabs (ulaw_8000)
Audio TTS → Twilio → Usuario
```

## Endpoints y rutas

- HTTP: `POST /voice/incoming` (TwiML inicial), `POST /voice/resume` (reconexión de stream).
- WebSocket: `/voice/stream` (Twilio ↔ StreamsGateway).
- Upstreams externos:
  - ElevenLabs STT: `wss://api.elevenlabs.io/v1/speech-to-text/stream`
  - ElevenLabs TTS: `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream`
  - OpenAI Chat Completions (modelo `OPENAI_MODEL`, por defecto `gpt-4o-mini`)
  - Deepgram Voice Agent (fallback STT/LLM): `wss://agent.deepgram.com/v1/agent/converse`

## Flujo paso a paso

1. **Webhook entrante (`/voice/incoming`)**
   - Twilio envía `To`, `From`, `CallSid`.
   - Se busca en Firestore `users.twilio.phoneNumber == To` (sin `+34` ni no numérico).
   - Si no hay agente: `say` con error y finaliza.
   - Si hay agente: se construye TwiML `<Stream>` hacia `/voice/stream` con `track="inbound_track"` y parámetros:
     - `agentName`, `greeting` (texto), `greetingUrl`, `instructions` (hasta 50k chars), `labsId` (voz ElevenLabs), `language` (código idioma).

2. **Conexión WS Twilio → `/voice/stream`**
   - `StreamsGateway` crea `CallSession` por `callSid`, guarda `streamSid`, parámetros, instrucciones, voz y idioma.
   - Elige proveedor STT inicial: `STT_PROVIDER` (default `elevenlabs`); si falta `ELEVENLABS_API_KEY` o hay error, cae a Deepgram.
   - Si hay `greeting`, se marca como pendiente para reproducir cuando el proveedor esté listo.

3. **Inicio STT**
   - ElevenLabs: abre WS y envía `start` con `model_id`, `language`, `encoding=mulaw`, `sample_rate=8000`. Al `open` marca `readyForAudio=true`, drena audio en cola y lanza greeting vía ElevenLabs TTS.
   - Deepgram (fallback): abre WS y envía `Settings` (idioma, modelos listen/speak, think); espera `SettingsApplied` para marcar `readyForAudio=true` y drenar audio. Greeting opcional se inyecta con `InjectAgentMessage`, pero el audio de salida igualmente se sintetiza con ElevenLabs TTS interceptando `ConversationText`.

4. **Audio entrante**
   - Twilio envía eventos `media` (μ-law base64). Si `readyForAudio=false`, se encola hasta `maxBufferedChunks`.
   - Al estar listo, cada chunk se reenvía al STT activo (ElevenLabs o Deepgram).
   - Si el agente está hablando y entra audio, se marca `interrupted=true` y se cancela TTS en curso (barge-in).

5. **Transcripción y LLM**
   - STT final → `handleFinalTranscript`: agrega mensaje de usuario al historial y llama a OpenAI Chat (`OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_TOKENS`) con `system: instructions` + historial.
   - Respuesta del LLM se marca `agentSpeaking=true` y se pasa a TTS.

6. **TTS y envío a Twilio**
   - ElevenLabs TTS (voz `labsId` o `ELEVENLABS_TTS_VOICE_ID`, `output_format=ulaw_8000` o conversión desde `pcm_16000`): se streamean chunks al WS de Twilio como `media` outbound (base64).
   - Si `interrupted`, no se envían más chunks y se destruye el stream TTS.

7. **Eventos clave**
   - `connected`: ignorado.
   - `start`: crea sesión.
   - `media`: audio entrante → STT.
   - `stop` o cierre WS: `cleanupSession` (cierra sockets STT/Deepgram, timers keep-alive, cancela TTS, borra sesión).

## Configuraciones y proveedores

- **STT principal**: ElevenLabs (`STT_PROVIDER=elevenlabs`). Fallback automático a Deepgram si falta clave o falla la conexión.
- **TTS**: Siempre ElevenLabs (independiente del STT); soporta `ulaw_8000` nativo o conversión desde `pcm_16000`.
- **LLM**: OpenAI Chat completions (`OPENAI_MODEL`, default `gpt-4o-mini`).
- **Barge-in**: detección de transcripción mientras `agentSpeaking=true` → `interrupted=true` → cancela TTS y prioriza nueva entrada de usuario.
- **Greeting**: texto `greeting` (o basado en `agentName`) se reproduce al iniciar servicios; durante greeting se deshabilitan interrupciones.

## Variables de entorno principales

- Routing: `NODE_ENV` (elige WS público vs local), `STT_PROVIDER`, `TTS_PROVIDER`.
- ElevenLabs STT/TTS: `ELEVENLABS_API_KEY`, `ELEVENLABS_STT_URL`, `ELEVENLABS_STT_MODEL`, `ELEVENLABS_LANGUAGE`, `ELEVENLABS_TTS_VOICE_ID`, `ELEVENLABS_TTS_MODEL_ID`, `ELEVENLABS_TTS_OUTPUT_FORMAT` (`ulaw_8000`|`pcm_16000`), `ELEVENLABS_TTS_STABILITY`, `ELEVENLABS_TTS_STYLE`, `ELEVENLABS_TTS_SIMILARITY`, `ELEVENLABS_TTS_SPEAKER_BOOST`, `ELEVENLABS_TTS_VOICE_SPEED`.
- Deepgram (fallback): `DG_VOICE_AGENT_API_KEY`/`DG_API_KEY`, `DG_VOICE_AGENT_URL`, `DG_VOICE_AGENT_LANGUAGE`, `DG_LISTEN_PROVIDER`, `DG_LISTEN_MODEL`, `DG_SPEAK_PROVIDER`, `DG_SPEAK_MODEL`, `DG_THINK_PROVIDER`, `DG_THINK_MODEL`, `DG_THINK_TEMPERATURE`, `DG_KEEPALIVE_MS`, `DG_MAX_BUFFERED_CHUNKS`, `DG_AGENT_PROMPT`.
- LLM: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_TOKENS`.
- Otros: `ELEVENLABS_BASE_URL`, `ELEVENLABS_STT_URL`, `ELEVENLABS_TTS_OUTPUT_FORMAT`.

## Logs útiles (esperados)

- Inicio: `📞 [callSid] Llamada iniciada`, `🔌 STT ElevenLabs conectado` o `⚙️ Deepgram listo`.
- STT: `✏️ Parcial STT`, `📝 Transcripción final`.
- LLM: `💬 Respuesta LLM: ...`
- TTS: `🎵 Iniciando TTS...`, `📦 Chunk recibido...`, `✅ Stream ElevenLabs TTS terminado`.
- Barge-in: `🛑 Usuario interrumpió al agente`.
- Fin: `🛑 Llamada terminada`, `🧹 Limpiando sesión`.
