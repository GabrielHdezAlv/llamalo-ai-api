# Configuración de API Keys

## Google Cloud y Gemini AI

### Variables de Entorno Requeridas

Para usar Google Cloud Speech-to-Text, Gemini API y Google Cloud Text-to-Speech, necesitas configurar:

```env
# Gemini API
GEMINI_API_KEY=tu_api_key_de_gemini
GEMINI_MODEL=gemini-1.5-flash  # Opcional, por defecto: gemini-1.5-flash
GEMINI_TEMPERATURE=0.7  # Opcional, por defecto: 0.7
GEMINI_AGENT_PROMPT="Eres un asistente..."  # Opcional, instrucciones por defecto

# Google Cloud
GOOGLE_CLOUD_PROJECT_ID=tu-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json  # Opcional si usas service account
GOOGLE_TTS_VOICE_NAME=es-ES-Neural2-D  # Opcional, por defecto: es-ES-Neural2-D

# Configuración general
MAX_BUFFERED_CHUNKS=25  # Opcional, por defecto: 25
```

### 1. Obtener Gemini API Key

1. Ir a: https://aistudio.google.com/app/apikey
2. Crear nueva API key
3. Copiar la key y actualizar `GEMINI_API_KEY` en tu `.env` o variables de entorno de Render

### 2. Configurar Google Cloud

#### Opción A: Service Account (Recomendado para producción)

1. Ir a: https://console.cloud.google.com/iam-admin/serviceaccounts
2. Crear o seleccionar un service account
3. Añadir roles:
   - `Cloud Speech-to-Text API User`
   - `Cloud Text-to-Speech API User`
4. Crear una key JSON y descargarla
5. Subir el archivo JSON a tu servidor (Render permite subir archivos secretos)
6. Configurar `GOOGLE_APPLICATION_CREDENTIALS` con la ruta al archivo JSON

#### Opción B: Application Default Credentials (ADC)

Si ejecutas en Google Cloud (Cloud Run, GCE, etc.), las credenciales se detectan automáticamente.

### 3. Habilitar APIs de Google Cloud

Asegúrate de tener habilitadas estas APIs en tu proyecto:

- Cloud Speech-to-Text API
- Cloud Text-to-Speech API

Puedes habilitarlas en: https://console.cloud.google.com/apis/library

### 4. Configurar Voz de TTS

Puedes elegir diferentes voces en español:

- `es-ES-Neural2-D` (femenina, por defecto)
- `es-ES-Neural2-F` (femenina)
- `es-ES-Standard-A` (femenina)
- `es-ES-Standard-B` (masculina)
- `es-ES-Standard-C` (femenina)
- `es-ES-Standard-D` (masculina)

Ver todas las voces disponibles: https://cloud.google.com/text-to-speech/docs/voices

### 5. Verificar Configuración

Después de configurar, los logs deberían mostrar:

```
✅ [callSid] Cliente Gemini inicializado
✅ [callSid] Speech-to-Text streaming iniciado
⚙️ [callSid] Servicios de Google Cloud inicializados
```

## Fish Audio API Key (Deprecated - Ya no se usa)

### 1. Actualizar la API Key

Tu nueva API key es: `dac2b5ab1ddb44d9a7d84922262185f9`

**Actualizar en tu archivo `.env`** (o en las variables de entorno de Render):

```env
FISH_API_KEY=dac2b5ab1ddb44d9a7d84922262185f9
```

### 2. Verificar Permisos

Fish Audio **no tiene un sistema de permisos por API key**. Todas las API keys tienen acceso a todas las funcionalidades de tu cuenta.

Los límites dependen de tu **plan de suscripción**:

- **Plan Gratuito**: 
  - Límites diarios de uso
  - Puede tener restricciones en conexiones WebSocket simultáneas
  
- **Plan de Pago**: 
  - Mayor cuota de uso
  - Más conexiones WebSocket simultáneas
  - Menor latencia

### 3. Verificar que la API Key Funciona

Puedes probar tu API key con este comando en terminal:

```bash
curl -X POST https://api.fish.audio/v1/tts \
  -H "Authorization: Bearer dac2b5ab1ddb44d9a7d84922262185f9" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hola, esto es una prueba",
    "voice_id": "8d2c17a9b26d4d83888ea67a1ee565b2",
    "language": "es-ES",
    "format": "mp3"
  }'
```

Si la API key es válida, recibirás datos de audio en la respuesta.

### 4. Posibles Causas del Error 403

Si sigues recibiendo error 403 en conexiones WebSocket:

#### A. Plan Gratuito con Restricciones
Fish Audio puede restringir conexiones WebSocket en tiempo real en planes gratuitos.

**Solución**:
- Verificar tu plan en: https://fish.audio/pricing
- Considerar upgrade si necesitas conexiones WebSocket
- El modo HTTP fallback funciona perfectamente mientras tanto

#### B. Límite de Cuota Alcanzado
Si has usado toda tu cuota diaria/mensual.

**Solución**:
- Verificar uso en: https://fish.audio/console
- Esperar reset de cuota o upgrade de plan

#### C. Región/IP Bloqueada
Algunas APIs restringen por región o IP.

**Solución**:
- Verificar si tu servidor está en una región soportada
- Contactar soporte de Fish Audio

### 5. Modo HTTP Fallback (Alternativa)

El sistema **funciona perfectamente en modo HTTP fallback**. La única diferencia es la latencia:

- **WebSocket (Tiempo Real)**: ~1-2 segundos
- **HTTP Fallback**: ~3-5 segundos

Para tu caso de uso, el HTTP fallback es completamente funcional.

## Actualizar Variables de Entorno en Render

### Opción 1: Dashboard de Render

1. Ir a tu proyecto en Render: https://dashboard.render.com
2. Seleccionar tu servicio backend
3. Ir a "Environment" en el menú lateral
4. Buscar `FISH_API_KEY`
5. Hacer clic en "Edit" y actualizar el valor a: `dac2b5ab1ddb44d9a7d84922262185f9`
6. Hacer clic en "Save Changes"
7. Render reiniciará automáticamente el servicio

### Opción 2: Archivo .env (Desarrollo Local)

Si estás probando localmente, actualiza tu archivo `.env`:

```env
# Fish Audio
FISH_API_KEY=dac2b5ab1ddb44d9a7d84922262185f9
FISH_LANG=es-ES
FISH_TTS_VOICE_ID=8d2c17a9b26d4d83888ea67a1ee565b2
FISH_ASR_SAMPLE_RATE=8000
FISH_ASR_ENCODING=pcm16

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.7

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...

# Firebase
FIREBASE_STORAGE_BUCKET=llamaloio.firebasestorage.app

# Sistema
ENABLE_AUTO_RESPONSE=true
NODE_ENV=development
```

## Otras API Keys Necesarias

### OpenAI API Key

Para GPT, necesitas una API key de OpenAI:

1. Ir a: https://platform.openai.com/api-keys
2. Crear nueva API key
3. Actualizar `OPENAI_API_KEY` en tu `.env`

Verificar que tengas créditos disponibles en: https://platform.openai.com/usage

### Twilio Credentials

Para llamadas telefónicas:

1. **Account SID y Auth Token**:
   - Ir a: https://console.twilio.com
   - Copiar Account SID y Auth Token desde el dashboard
   - Actualizar `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN`

2. **Configurar Webhook**:
   - En Twilio Console, ir a Phone Numbers
   - Seleccionar tu número
   - En "Voice & Fax" > "A CALL COMES IN":
     - Webhook: `https://llamaloiabackend-5294.onrender.com/voice/incoming`
     - HTTP POST

### Firebase Service Account

Para almacenar audios:

1. El proyecto ya debería tener configurado Firebase
2. Verificar que `FIREBASE_STORAGE_BUCKET` esté configurado
3. Verificar que el service account tenga permisos de escritura en Storage

## Verificación Post-Configuración

Después de actualizar las API keys, hacer una llamada de prueba:

### Logs Esperados (con nueva API key):

```
📞 Llamada entrante detectada
✅ TwiML generado correctamente
📄 TwiML generado: <Response>...
🛰️ Twilio WS conectado
🔑 FISH_API_KEY: ✅ Configurado
✅ ASR + TTS conectados en XXms  ← Si funciona WebSocket
```

O:

```
❌ Error conectando ASR/TTS: Error: Unexpected server response: 403
🔄 Usando modo fallback HTTP...  ← Si usa HTTP (también funciona)
```

### Logs del Evento Start (después del fix):

```
📨 Twilio mensaje recibido: start
📋 Mensaje completo del start: {
  "event": "start",
  "start": {
    "callSid": "CAxxxx...",
    "streamSid": "MZxxxx...",
    ...
  }
}
🎯 CallSid recibido: "CAxxxx..."
📝 [CAxxxx...] Creando nueva sesión
```

## Resumen de Pasos

1. ✅ Actualizar `FISH_API_KEY=dac2b5ab1ddb44d9a7d84922262185f9` en Render
2. ✅ Hacer commit y push del fix del TwiML
3. ✅ Esperar que Render redeploy automáticamente
4. ✅ Hacer una llamada de prueba
5. ✅ Verificar los logs

## Soporte

Si después de estos cambios sigues teniendo problemas:

- **Fish Audio**: support@fish.audio
- **Twilio**: https://support.twilio.com
- **OpenAI**: https://help.openai.com

---

**Nota**: La API key `dac2b5ab1ddb44d9a7d84922262185f9` ya está expuesta en este documento. Considera rotar la key después de solucionar los problemas si te preocupa la seguridad.

