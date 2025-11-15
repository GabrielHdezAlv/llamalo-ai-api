# Troubleshooting - LlamaloAI

## Problemas Comunes y Soluciones

### 1. Error 403 al conectar con Fish Audio WebSocket

**Síntoma**:
```
❌ Error conectando ASR/TTS: Error: Unexpected server response: 403
🔄 Usando modo fallback HTTP...
```

**Causas Posibles**:

#### A. API Key Inválida o Expirada
- La `FISH_API_KEY` no es válida
- La API key no tiene permisos para conexiones WebSocket
- La API key ha expirado

**Solución**:
1. Verificar que `FISH_API_KEY` esté correctamente configurada en el archivo `.env`
2. Generar una nueva API key desde [Fish Audio Console](https://fish.audio/console)
3. Asegurarse de que la API key tenga permisos para:
   - ASR (Speech to Text)
   - TTS (Text to Speech)
   - Conexiones WebSocket en tiempo real

#### B. Límite de Conexiones Alcanzado
- Fish Audio puede tener límites de conexiones simultáneas
- El plan gratuito tiene restricciones

**Solución**:
1. Verificar el plan actual en Fish Audio
2. Considerar upgrade si se necesitan más conexiones
3. El sistema automáticamente usa HTTP fallback, que funciona correctamente

#### C. Restricciones de IP o Región
- Algunas APIs restringen conexiones desde ciertas regiones
- Cloudflare o proxies pueden interferir

**Solución**:
1. Verificar que la IP del servidor esté permitida
2. Si usas Cloudflare, verificar configuración de WebSocket
3. Contactar soporte de Fish Audio si el problema persiste

**Nota**: El error 403 NO afecta el funcionamiento del sistema, ya que automáticamente cambia a modo HTTP fallback que funciona perfectamente.

---

### 2. "No hay sesión para callSid"

**Síntoma**:
```
⚠️ No hay sesión para callSid: 
⚠️ Recibido evento media antes del start, ignorando...
```

**Causa**:
El evento `start` de Twilio no está llegando o no contiene el `callSid`.

**Diagnóstico**:
Los logs mostrarán:
```
📨 Twilio mensaje recibido: start
📋 Mensaje completo del start: { ... }
🎯 CallSid recibido: ""
```

**Soluciones**:

#### A. Verificar TwiML
Asegurarse de que el TwiML enviado a Twilio incluya correctamente el stream:

```xml
<Response>
  <Play>https://storage.googleapis.com/bucket/audio.mp3</Play>
  <Start>
    <Stream url="wss://your-backend.com/voice/stream" />
  </Start>
  <Pause length="600" />
</Response>
```

#### B. Verificar Orden de Eventos
Twilio debe enviar eventos en este orden:
1. `connected` (opcional)
2. `start` ← debe contener callSid
3. `media` ← múltiples eventos de audio
4. `stop` ← cuando termina la llamada

#### C. Revisar Webhook de Twilio
Verificar en el dashboard de Twilio que:
- El webhook esté apuntando a la URL correcta
- El webhook esté usando HTTPS (no HTTP)
- No haya errores en los logs de Twilio

#### D. Verificar Configuración del Stream
En el código de `CallsController`:

```typescript
const start = r.start();
start.stream({ url: wsUrl });  // ✅ URL correcta
```

**Debugging Adicional**:
Si el problema persiste, los logs mejorados mostrarán todo el contenido del mensaje `start` para identificar el problema específico.

---

### 3. Audio No Se Reproduce en la Llamada

**Síntoma**:
El usuario no escucha la respuesta del agente.

**Causas y Soluciones**:

#### A. Modo WebSocket (Tiempo Real)
Si los logs muestran:
```
✅ ASR + TTS conectados en XXms
🔊 [callSid] Audio TTS emitido (X samples)
```

Pero el usuario no escucha:
1. Verificar que Twilio esté recibiendo el audio
2. Revisar formato de audio (debe ser μ-law base64)
3. Verificar que el evento `media` se envíe correctamente al cliente

#### B. Modo HTTP Fallback
Si los logs muestran:
```
🔄 Usando modo fallback HTTP...
🎧 [callSid] Audio enviado a Twilio
```

Pero el usuario no escucha:
1. Verificar que el archivo MP3 se haya subido a Firebase Storage
2. Verificar que la URL sea pública y accesible
3. Verificar que `TwilioCallMediaService.playUrl()` se ejecute sin errores
4. Verificar credenciales de Twilio (ACCOUNT_SID y AUTH_TOKEN)

---

### 4. Transcripción No Funciona (ASR)

**Síntoma**:
No se ven logs de transcripción o están vacíos.

**Diagnóstico**:

#### Modo WebSocket:
```
🎙️ [callSid] ASR: "" (final)
```

#### Modo HTTP:
```
🕸️ [callSid] Chunk HTTP sin transcripción utilizable.
```

**Soluciones**:

#### A. Verificar Audio de Entrada
- El audio debe ser PCM16 mono 8kHz
- Verificar que `ulawToPcm16()` funcione correctamente
- Verificar que Twilio esté enviando audio válido

#### B. Verificar Configuración de Fish Audio
```env
FISH_API_KEY=your_key
FISH_LANG=es-ES  # ✅ Idioma correcto
FISH_ASR_SAMPLE_RATE=8000  # ✅ Debe ser 8000 para Twilio
FISH_ASR_ENCODING=pcm16
```

#### C. Verificar Tamaño de Audio
En modo HTTP, el sistema acumula mínimo 1 segundo de audio (16000 bytes):
```typescript
const minAudioSize = 16000; // 1 segundo a 8kHz 16-bit mono
```

Si el usuario habla muy poco, puede que no se alcance el mínimo.

#### D. Verificar Idioma
Si el usuario habla en un idioma diferente al configurado en `FISH_LANG`, la transcripción puede fallar.

---

### 5. GPT No Responde

**Síntoma**:
```
🎙️ [callSid] ASR: "hola" (final)
✅ [callSid] Transcripción final detectada.
```

Pero no hay logs de GPT.

**Soluciones**:

#### A. Verificar ENABLE_AUTO_RESPONSE
```env
ENABLE_AUTO_RESPONSE=true  # ✅ Debe estar en true
```

Si está en `false`, el sistema solo registra las transcripciones pero no genera respuestas.

#### B. Verificar OpenAI API Key
```env
OPENAI_API_KEY=sk-...  # ✅ Debe ser válida
OPENAI_MODEL=gpt-4o-mini
```

Verificar en los logs:
```
❌ Error procesando respuesta GPT: [error details]
```

#### C. Verificar Límites de OpenAI
- Verificar que la cuenta de OpenAI tenga créditos
- Verificar que no se hayan alcanzado límites de rate limiting

---

### 6. Múltiples Llamadas Simultáneas Fallan

**Síntoma**:
La primera llamada funciona pero las siguientes fallan.

**Diagnóstico**:
```
⚠️ Sesiones disponibles: call123, call456, call789
⚠️ No hay sesión para callSid: "call999"
```

**Causas Posibles**:

#### A. Callbacks de ASR/TTS Compartidos
Este problema ya está solucionado en la refactorización actual. Cada sesión tiene sus propios callbacks.

#### B. Límite de Conexiones WebSocket
Fish Audio puede limitar conexiones simultáneas. El sistema usará HTTP fallback automáticamente.

**Solución**:
El sistema está diseñado para manejar múltiples llamadas correctamente. Si hay problemas:
1. Verificar logs de cada callSid por separado
2. Verificar que cada sesión se cree y limpie correctamente
3. Verificar límites del proveedor (Fish Audio, OpenAI)

---

### 7. Latencia Alta / Respuestas Lentas

**Métricas Esperadas**:
```
📊 Métricas — ASR 150ms | GPT 800ms | TTS 200ms
```

**Latencia Total Esperada**: 1-3 segundos

**Si la latencia es mayor**:

#### A. Modo HTTP Fallback es Más Lento
El modo HTTP tiene mayor latencia que WebSocket:
- **WebSocket**: ~1-2 segundos
- **HTTP**: ~3-5 segundos

**Solución**: Resolver el error 403 de Fish Audio para usar WebSocket.

#### B. Modelo GPT Lento
Modelos más grandes son más lentos:
- `gpt-4o-mini`: ~800ms primer token
- `gpt-4`: ~2000ms primer token

**Solución**: Usar `gpt-4o-mini` para menor latencia.

#### C. Red Lenta
Si el servidor está en una región lejana a los servicios de API.

**Solución**:
- Usar servidor en región cercana a Fish Audio y OpenAI
- Considerar Cloudflare Workers para enrutamiento optimizado

---

### 8. Memory Leaks / Uso Excesivo de Memoria

**Síntoma**:
El servidor se queda sin memoria después de muchas llamadas.

**Diagnóstico**:
```bash
# Verificar memoria
node --max-old-space-size=512
```

**Soluciones**:

#### A. Verificar Limpieza de Sesiones
Cada llamada debe limpiarse al terminar:
```
🧹 [callSid] Limpiando sesión
```

Si no aparece este log, las sesiones no se están limpiando.

#### B. Verificar Timers
Todos los timers deben cancelarse:
```typescript
if (session.audioBufferTimer) {
  clearTimeout(session.audioBufferTimer);
}
```

#### C. Verificar Buffers
Los buffers deben liberarse:
```typescript
session.audioBuffer = Buffer.alloc(0);
```

---

## Verificación del Sistema

### Checklist Pre-Producción

- [ ] ✅ `FISH_API_KEY` configurada y válida
- [ ] ✅ `OPENAI_API_KEY` configurada y válida
- [ ] ✅ `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` configurados
- [ ] ✅ `FIREBASE_STORAGE_BUCKET` configurado
- [ ] ✅ `ENABLE_AUTO_RESPONSE=true`
- [ ] ✅ Webhook de Twilio apuntando a URL correcta
- [ ] ✅ WebSocket accesible en `/voice/stream`
- [ ] ✅ Agentes configurados en Firestore con números Twilio
- [ ] ✅ Audio de bienvenida subido y accesible

### Prueba Manual

1. **Llamar al número de Twilio**
2. **Verificar logs esperados**:
   ```
   📞 Llamada entrante detectada
   ✅ TwiML generado correctamente
   🛰️ Twilio WS conectado
   🎯 CallSid recibido: "CAxxxx"
   📝 [CAxxxx] Creando nueva sesión
   📨 Twilio mensaje recibido: media
   🎙️ [CAxxxx] ASR: "hola" (final)
   🧭 [CAxxxx] Procesando respuesta GPT
   💬 [CAxxxx] GPT streaming: "Hola, ..."
   🔊 [CAxxxx] Audio TTS emitido
   ```
3. **Verificar que el usuario escuche las respuestas**
4. **Verificar que la llamada termine correctamente**:
   ```
   🛑 [CAxxxx] Llamada terminada
   🧹 [CAxxxx] Limpiando sesión
   ```

---

## Contacto y Soporte

Si después de seguir esta guía el problema persiste:

1. **Logs Completos**: Capturar los logs completos de la llamada
2. **Variables de Entorno**: Verificar que todas las variables estén configuradas (sin exponer las keys)
3. **Versión de Node**: Verificar versión (`node --version`)
4. **Versión de Dependencias**: Verificar `package.json`

Para reportar issues: [GitHub Issues](https://github.com/GabrielHdezAlv/llamalo-ai-api/issues)

