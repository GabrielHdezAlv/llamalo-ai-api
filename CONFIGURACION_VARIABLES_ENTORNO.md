# Configuración de Variables de Entorno

## ⚠️ Importante: Seguridad

Los archivos `.env` **NO** deben estar en el repositorio Git por seguridad. Contienen información sensible como API keys y tokens.

## Variables de Entorno Requeridas

### Deepgram Voice Agent (STT)
```bash
DG_VOICE_AGENT_API_KEY=b2fb2220cfa8e8d99ee9c96fb906f3da0c68051a
DG_VOICE_AGENT_URL=wss://agent.deepgram.com/v1/agent/converse
DG_VOICE_AGENT_LANGUAGE=es
DG_LISTEN_PROVIDER=deepgram
DG_LISTEN_MODEL=nova-3
DG_SPEAK_PROVIDER=deepgram
DG_SPEAK_MODEL=aura-2-nestor-es
DG_THINK_PROVIDER=deepgram
DG_THINK_MODEL=dg-llama-3.1-8b
DG_THINK_TEMPERATURE=0.7
DG_KEEPALIVE_MS=15000
DG_MAX_BUFFERED_CHUNKS=25
```

### ElevenLabs (TTS)
```bash
ELEVENLABS_API_KEY=tu_api_key_aqui
ELEVENLABS_LANGUAGE=es
ELEVENLABS_TTS_VOICE_ID=15bJsujCI3tcDWeoZsQP
ELEVENLABS_TTS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_TTS_STABILITY=0.72
ELEVENLABS_TTS_STYLE=0.05
ELEVENLABS_TTS_SIMILARITY=0.8
ELEVENLABS_TTS_SPEAKER_BOOST=true
ELEVENLABS_TTS_VOICE_SPEED=0.98
ELEVENLABS_TTS_OUTPUT_FORMAT=ulaw_8000
```

### OpenAI (LLM)
```bash
OPENAI_API_KEY=tu_api_key_aqui
OPENAI_MODEL=gpt-4o
OPENAI_TEMPERATURE=0.4
OPENAI_MAX_TOKENS=200
# Primer turno del usuario en llamadas Twilio (reduce latencia inicial)
OPENAI_MODEL_FIRST_TURN=gpt-4o-mini
OPENAI_MAX_TOKENS_FIRST_TURN=250
```

### Twilio
```bash
TWILIO_ACCOUNT_SID=tu_account_sid
TWILIO_AUTH_TOKEN=tu_auth_token
```

#### ⚠️ Configuración Crítica del Webhook de Voz en Twilio
Para que las llamadas entren a la plataforma y puedan ser gestionadas correctamente por los agentes, debes configurar manualmente la URL de voz en Twilio:
1. Ve a **Phone Numbers > Manage > Active Numbers** en tu consola de Twilio.
2. Selecciona el número que quieres configurar.
3. Baja hasta la sección **"Voice & Fax"**.
4. En **"A call comes in"**, selecciona **Webhook**.
5. Pega la URL de tu API: `https://tu-dominio.com/voice/incoming` (Asegúrate de cambiar "tu-dominio.com" por tu dominio real de producción o de ngrok).
6. A la derecha, asegúrate de que el método sea **HTTP POST**.
7. Guarda los cambios.

### Shopify
```bash
SHOPIFY_API_KEY=tu_api_key
SHOPIFY_API_SECRET=tu_api_secret
APP_URL=https://tu-dominio.com
```

## Configuración Local (Desarrollo)

1. Copia el archivo de ejemplo:
   ```bash
   cp env.example .env.development
   ```

2. Edita `.env.development` y agrega tus API keys reales.

3. Los archivos `.env*` están en `.gitignore` y **NO** se subirán al repositorio.

## Configuración en Producción (Render)

### Pasos para configurar en Render:

1. Ve a tu servicio en [Render Dashboard](https://dashboard.render.com)

2. Navega a **Environment** en el menú lateral

3. Agrega cada variable de entorno una por una:
   - Click en **"Add Environment Variable"**
   - Ingresa el **Key** (nombre de la variable)
   - Ingresa el **Value** (valor de la variable)
   - Click en **"Save Changes"**

4. **Variables críticas que debes configurar:**
   - `DG_VOICE_AGENT_API_KEY` = `b2fb2220cfa8e8d99ee9c96fb906f3da0c68051a`
   - `ELEVENLABS_API_KEY` = (tu API key de ElevenLabs)
   - `OPENAI_API_KEY` = (tu API key de OpenAI)
   - `TWILIO_ACCOUNT_SID` = (tu Account SID de Twilio)
   - `TWILIO_AUTH_TOKEN` = (tu Auth Token de Twilio)
   - `SHOPIFY_API_KEY` = (tu API key de Shopify)
   - `SHOPIFY_API_SECRET` = (tu API secret de Shopify)

5. Después de agregar todas las variables, **reinicia el servicio** para que tome los cambios.

## Verificación

Para verificar que las variables están configuradas correctamente:

1. En Render, ve a **Logs** de tu servicio
2. Busca mensajes como:
   - `✅ Variables de entorno cargadas correctamente`
   - O errores como: `⚠️ ELEVENLABS_API_KEY no configurado`

## Rotación de API Keys

Si alguna API key se expuso accidentalmente:

1. **Deepgram**: Ve a [Deepgram Console](https://console.deepgram.com/) → Settings → API Keys → Revoke la key expuesta → Crea una nueva
2. **ElevenLabs**: Ve a [ElevenLabs Dashboard](https://elevenlabs.io/app/settings/api-keys) → Revoke → Create new
3. **OpenAI**: Ve a [OpenAI Platform](https://platform.openai.com/api-keys) → Revoke → Create new
4. Actualiza la variable de entorno en Render con la nueva key
5. Reinicia el servicio

## Notas Importantes

- ⚠️ **NUNCA** subas archivos `.env` al repositorio Git
- ✅ Usa `env.example` como plantilla (sin valores reales)
- ✅ Configura las variables en el servidor de producción (Render, etc.)
- ✅ Mantén los archivos `.env` solo localmente para desarrollo
- ✅ Rota las API keys si se expusieron accidentalmente
