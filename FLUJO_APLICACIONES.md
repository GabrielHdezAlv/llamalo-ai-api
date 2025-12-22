# Flujo de aplicaciones y propósito

Este documento resume, de forma breve y legible, qué piezas usamos en la plataforma de voz y para qué sirve cada una.

## Componentes principales

- **Twilio (voz entrante/saliente)**  
  Recibe y origina llamadas telefónicas. Envía/recibe audio en tiempo real a nuestro backend mediante WebSocket (`/voice/stream`).

- **Streams Gateway (NestJS, `src/streams/streams.gateway.ts`)**  
  Puerta de entrada WebSocket. Gestiona sesiones, enruta audio, lanza el TTS y el STT según el proveedor seleccionado y aplica las instrucciones del agente (prompt).

- **STT (Speech-to-Text)**
  - _ElevenLabs Realtime_ (cuando se usa proveedor `elevenlabs`).
  - _Deepgram Voice Agent_ (fallback o configuración por defecto).  
    Convierte audio de usuario en texto para alimentar al LLM.

- **LLM (OpenAI Chat Completions)**  
  Genera las respuestas de texto del agente usando el prompt/instrucciones configuradas y el historial de la conversación.

- **TTS (Text-to-Speech, ElevenLabs)**  
  Convierte la respuesta de texto del LLM en audio μ-law (`ulaw_8000`) que se envía a Twilio sin reconversión adicional.

- **Firebase/Firestore**  
  Almacena configuración del usuario/agente (Twilio, instrucciones, voz, idioma, etc.) y se consulta en tiempo de llamada.

## Flujo resumido de una llamada

1. **Twilio recibe/lanza la llamada** y abre un WebSocket a `/voice/stream` con parámetros (greeting, instructions, labsId, language…).
2. **Streams Gateway crea la sesión**, lee parámetros y arranca el proveedor de STT. Si hay greeting, lo sintetiza con ElevenLabs y lo envía a Twilio.
3. **Audio entrante → STT**: el usuario habla; el STT devuelve texto.
4. **Texto → LLM**: se agrega al historial y se consulta OpenAI con el prompt del agente.
5. **Respuesta del LLM → TTS**: ElevenLabs genera audio μ-law y se reenvía a Twilio para que el usuario lo escuche.
6. **Bucle**: se repite mientras dura la llamada; se controlan interrupciones y turnos de voz.
7. **Fin de llamada**: Twilio envía `stop`; se limpian recursos de la sesión.

## Configuración clave (variables de entorno)

- `ELEVENLABS_API_KEY`, `ELEVENLABS_TTS_VOICE_ID`, `ELEVENLABS_TTS_MODEL_ID`, `ELEVENLABS_TTS_STABILITY`, `ELEVENLABS_TTS_SIMILARITY`, `ELEVENLABS_TTS_STYLE`, `ELEVENLABS_TTS_SPEAKER_BOOST`, `ELEVENLABS_TTS_VOICE_SPEED`, `ELEVENLABS_LANGUAGE`.
- `DG_VOICE_AGENT_API_KEY` / `DG_API_KEY`, `DG_AGENT_PROMPT`.
- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_TOKENS`.
- `TWILIO_*` (SID, token, números, etc.) gestionados por usuario en Firestore.

## Nota sobre instrucciones (prompt)

- Twilio pasa las instrucciones como parámetro del Stream; se registran la longitud y el tail para verificar truncados.
- Si se requiere un prompt más largo que el límite de Twilio, conviene pasar solo un ID/URL y cargar el texto completo desde backend.

## Cómo leer el código

- Entrada de llamadas y TwiML: `src/calls/calls.controller.ts`.
- Lógica de streaming, STT/TTS y LLM: `src/streams/streams.gateway.ts`.
- Configuración/env: `env.example` y variables en `main.ts` / módulos Nest.
