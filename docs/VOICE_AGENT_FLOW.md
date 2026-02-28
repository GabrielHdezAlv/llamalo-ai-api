# Arquitectura del Agente de Voz (Llamalo.ai)

Este documento describe el flujo técnico completo, paso a paso, de cómo se procesa una llamada de voz en el backend (`src/streams/streams.gateway.ts`).

---

## 📞 1. Flujo de Audio y Componentes Activos

Actualmente, **solo hay un flujo activo** para la lógica del agente, pero utiliza 3 proveedores diferentes interconectados.

El stack actual es:
1. **Telefonía:** Twilio (WebSockets)
2. **STT (Voz a Texto):** Deepgram (usando su API de Voice Agent, pero con las respuestas automáticas deshabilitadas).
3. **LLM (Cerebro/IA):** OpenAI (usando `gpt-4o-mini` por defecto).
4. **TTS (Texto a Voz):** ElevenLabs.

*Nota: Deepgram solo se usa como "oído" (transcriptor). Cuando detecta que el usuario terminó de hablar, envía un evento de texto al backend, el cual usamos para llamar a OpenAI.*

---

## 🔄 2. El Ciclo de Vida de una Llamada (Paso a Paso)

### A. Inicialización (Evento `start` de Twilio)
1. Twilio se conecta a nuestro WebSocket.
2. Extraemos los metadatos de la llamada (`userId`, `shopDomain`, `callerPhone`, `instructions`, `voiceId`).
3. **Contexto Dinámico (Shopify):** Se cargan los datos de la tienda, productos y se busca al cliente por su número de teléfono.
4. **Contexto Estático:** Se leen los archivos de prompts (`voice-rules.md`) y conocimiento corporativo de `src/knowledge/`.
5. Abrimos una conexión WebSocket hacia **Deepgram**.

### B. El Usuario Habla (Flujo STT)
1. Twilio envía paquetes de audio (en formato μ-law 8kHz) en eventos `media`.
2. El backend reenvía este audio crudo inmediatamente al WebSocket de Deepgram.

### C. Barge-in (Interrupción Inmediata) ⚡ IMPLEMENTADO
1. Si el agente está hablando y Deepgram detecta que el usuario hace ruido (evento `UserStartedSpeaking`), el backend actúa en milisegundos.
2. Detiene la generación de ElevenLabs.
3. Envía un evento `{ event: "clear" }` a Twilio para vaciar el buffer de audio telefónico. **El agente se calla al instante.**

### D. La IA Responde (LLM -> TTS en Streaming) ⚡ IMPLEMENTADO
1. Cuando el usuario se calla, el backend envía todo el contexto ensamblado a **OpenAI** con el parámetro `stream: true`.
2. A medida que OpenAI genera la respuesta token a token, el backend los agrupa por oraciones (buscando puntos, comas o signos de interrogación).
3. En cuanto se completa una oración (ej. *"¡Claro!"*), se envía inmediatamente a **ElevenLabs** vía HTTP POST en modo stream.
4. Mientras el usuario escucha *"¡Claro!"*, OpenAI sigue generando el resto de la frase en segundo plano. Esto mantiene la latencia por debajo de los ~800ms.

### E. Reproducción y Envío (TTS -> Twilio)
1. A medida que llegan los "chunks" de audio desde ElevenLabs, el backend los envía de vuelta a Twilio envueltos en eventos JSON `{ event: "media" }`.
2. El usuario escucha la voz del agente de forma natural.

---

## 🏗️ 3. Mejoras Arquitectónicas Implementadas

Las siguientes optimizaciones ya están activas en producción para garantizar una experiencia telefónica realista:

* **Latencia Ultra-Baja:** El puente de streaming (OpenAI -> ElevenLabs por oraciones) elimina el "efecto walkie-talkie".
* **Voice UI (Humanización):** El System Prompt inyecta reglas estrictas obligando a la IA a usar frases de menos de 15 palabras, evitar viñetas Markdown y usar muletillas naturales ("A ver...", "Vale,").
* **Minimización de Datos (Shopify):** La API de Shopify solo se consulta bajo demanda, filtrando por el ID del cliente mediante una búsqueda previa por número de teléfono.
* **Temperatura Determinista:** El LLM opera con `temperature: 0.2` para dar respuestas concisas y evitar alucinaciones.