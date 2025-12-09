# 📞 Guía rápida de agentes telefónicos inbound en streaming

## ⚡ TL;DR stack recomendada

- STT: Deepgram Nova-2/3 (streaming, baja latencia). Alternativas: Whisper v3 streaming self-host si quieres control de datos/costos; ElevenLabs STT si prefieres un solo proveedor (validar pricing beta).
- LLM: gpt-4o-mini en modo streaming para bajo costo/latencia; subir a gpt-4o si hace falta más reasoning.
- TTS: ElevenLabs Realtime API (control de género/voz, velocidad, estilo). Alternativas: PlayHT v2, Azure Neural TTS (SSML granular).

## 🔄 Flujo inbound en streaming (ejemplo)

1. 📥 Audio entrante (PSTN/SIP/Twilio) → frames PCM 16 kHz mono.
2. 🎙️ STT streaming con timestamps → texto parcial.
3. 🤖 LLM streaming (contexto corto; política de barge-in para interrumpir).
4. 🔊 TTS streaming en chunks → playback inmediato; cortar al barge-in.
5. 📊 Métricas clave: latencia E2E p50/p95, WER, MOS de voz, % cortes TTS correctos.

## 🗣️ Ajustes de voz (ej. ElevenLabs)

- Voz base en Voice Design (género/timbre).
- Parámetros por request: `stability`, `similarity_boost`, `style`, `speaker_boost`, `voice_speed`.
- Pronunciación: lexicones/IPA; SSML-like tags donde aplique.
- Pista rápida: `voice_speed` ±10–20 % y `stability` 0.3–0.6 suelen dar naturalidad + dinámica.

## 🧪 Plan de pruebas rápido (1–2 días)

- Comparar:
  - (A) Deepgram STT + gpt-4o-mini + ElevenLabs TTS
  - (B) ElevenLabs STT + gpt-4o-mini + ElevenLabs TTS
- Escenarios: ruido de fondo, acentos locales, IVR/DTMF, barge-in agresivo.
- Capturar: latencia E2E, WER, MOS subjetivo, % barge-in correcto, coste estimado por llamada.

## 📊 Comparativa rápida (formato fichas, precios aprox. dic 2025)

### STT

- Deepgram Nova-2/3 → baja latencia, robusto a ruido. Precio: ~USD 0.006–0.008/min streaming (pay-as-you-go).
- Whisper v3 (OpenAI API) → alta calidad; opción self-host. Precio: ~USD 0.006/min API; self-host = coste de infra.
- ElevenLabs Realtime STT (Scribe v2 Realtime Developer API) → mismo proveedor que TTS. Pricing aprox (dic 2025): Starter USD 5/mes incluye 10 h (~USD 0.48/h incluidas); Creator USD 22/mes 48 h (~USD 0.46/h incluidas, USD 0.63/h extra); Pro USD 99/mes 225 h (~USD 0.44/h incluidas, USD 0.53/h extra); Scale USD 330/mes 786 h (~USD 0.42/h incluidas, USD 0.46/h extra); Business USD 1,320/mes 3,385 h (~USD 0.39/h incluidas y extra). Conversión rápida a minuto: ~USD 0.0065–0.0105/min según tier.

### LLM

- gpt-4o-mini → rápido y barato. Precio: ~USD 0.15/1M tokens in; ~USD 0.60/1M out.
- gpt-4o → mejor reasoning. Precio: ~USD 5/1M tokens in; ~USD 15/1M out.

### TTS

- ElevenLabs Realtime API → voz hiperrealista; control de género/velocidad/estilo. Precio: planes desde ~USD 5/mes (≈30k chars); facturación por caracteres; enterprise bajo demanda.
- PlayHT v2 → voces naturales; realtime. Precio: planes desde ~USD 29/mes (≈50k chars); revisar overages.
- Azure Neural TTS → SSML granular; multilenguaje. Precio: ~USD 16/1M caracteres (Standard Neural); Custom >.

### Infra

- Twilio Media Streams → PSTN↔WebSocket; soporta barge-in. Precio: ~USD 0.0085/min inbound local (según país).

Notas: los precios varían por región/plan/volumen; confirma siempre en la página oficial antes de cotizar.

## ✅ Propuesta preferida + coste estimado por minuto (llamada inbound)

Stack sugerido: Deepgram STT + gpt-4o-mini (streaming) + ElevenLabs Realtime TTS + Twilio Media Streams.

Supuestos de cálculo (aprox):

- Habla: ~140 palabras/min (≈200 tokens texto; ≈840 caracteres de respuesta TTS).
- STT (Deepgram): ~USD 0.006–0.008/min.
- LLM (gpt-4o-mini): in 200 tokens → USD 0.00003; out 200 tokens → USD 0.00012 → total ~USD 0.00015/min (prácticamente despreciable).
- TTS (ElevenLabs): plan base ~USD 5 por ~30k chars → ~USD 0.000167/char; para 840 chars/min → ~USD 0.14/min. En planes mayores el coste efectivo baja.
- Infra Twilio Media Streams: referencia genérica ~USD 0.0085/min inbound local; en España suele estar en el rango ~USD 0.009–0.011/min (verifica en el portal de precios de Twilio ES).

Estimado total por minuto (redondeado):

- Opción base recomendada (Deepgram + gpt-4o-mini + ElevenLabs TTS + Twilio): ~USD 0.16–0.17/min (usando rango Twilio ES ~0.009–0.011/min).
- Si usas ElevenLabs STT (Scribe v2 Realtime): añade ~USD 0.0065–0.0105/min según tier; total quedaría en ~USD 0.17–0.18/min en Creator/Pro y ~USD 0.16–0.17/min en Scale/Business (España, Twilio rango medio).
- Si usas Whisper v3 API en vez de Deepgram: STT ~USD 0.006/min → total ~USD 0.15–0.16/min.

Estimado por llamada típica en España (referencia):

- 3 minutos: ~USD 0.48–0.51.
- 5 minutos: ~USD 0.80–0.85.

Variante “stack único ElevenLabs”:

- STT ElevenLabs Scribe v2 Realtime + TTS ElevenLabs Realtime + gpt-4o-mini + Twilio.
- Coste por minuto: STT ~USD 0.0065–0.0105 + TTS ~USD 0.14 + Twilio ES ~USD 0.009–0.011 + LLM ~USD 0.00015 ≈ ~USD 0.16–0.17/min (depende del tier; Creator/Pro se acerca a 0.17–0.18 si usas precios extra).
- Útil si priorizas un solo proveedor de voz y simplificar integración; valida calidad STT en tus acentos/ruido antes de cierre.
- Estimado por llamada (España, ElevenLabs STT):
  - 3 minutos: ~USD 0.48–0.54 (incluidos vs. extra en Creator/Pro).
  - 5 minutos: ~USD 0.80–0.90 (incluidos vs. extra en Creator/Pro).

Notas rápidas:

- El mayor componente es TTS; optimiza longitud de respuesta y velocidad de habla para bajar coste.
- En enterprise/volumen, ElevenLabs y Deepgram suelen ofrecer descuentos por tier; valida con comercial.
