/**
 * URL del WebSocket que Twilio Media Streams debe usar (`<Connect><Stream url="…">`).
 *
 * Prioridad:
 * 1. TWILIO_MEDIA_STREAM_URL — URL completa (p. ej. wss://api.ejemplo.com/voice/stream)
 * 2. RENDER_EXTERNAL_URL — Render la define automáticamente (https://servicio.onrender.com)
 * 3. PUBLIC_API_URL o APP_URL — origen público del API (https://…)
 * 4. En desarrollo local: ws://127.0.0.1:${PORT}/voice/stream
 * 5. En producción sin ninguna de las anteriores: URL legacy (avisar en log)
 */
export function getTwilioMediaStreamWebSocketUrl(): string {
  const explicit = process.env.TWILIO_MEDIA_STREAM_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const baseRaw =
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    process.env.PUBLIC_API_URL?.trim() ||
    process.env.APP_URL?.trim();

  if (baseRaw) {
    const base =
      baseRaw.startsWith('http://') || baseRaw.startsWith('https://')
        ? baseRaw
        : `https://${baseRaw}`;
    try {
      const url = new URL(base);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${url.host}/voice/stream`;
    } catch {
      // continuar al fallback
    }
  }

  return fallbackTwilioMediaStreamUrl();
}

function fallbackTwilioMediaStreamUrl(): string {
  const port = process.env.PORT || process.env.APP_PORT || '3000';

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[Calls] Ninguna de TWILIO_MEDIA_STREAM_URL, RENDER_EXTERNAL_URL, PUBLIC_API_URL o APP_URL está definida; usando URL legacy de Media Stream.',
    );
    return 'wss://llamaloiabackend-5294.onrender.com/voice/stream';
  }

  return `ws://127.0.0.1:${port}/voice/stream`;
}
