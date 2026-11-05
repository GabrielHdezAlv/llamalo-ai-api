# LlamaloAI API

Backend de **LlamaloAI**, una plataforma SaaS de agentes telefónicos con IA: cada empresa configura su agente, le sube su conocimiento (PDFs, webs, texto) y el agente atiende llamadas reales por teléfono.

Construido con **NestJS (Node.js + TypeScript)**.

## Cómo funciona una llamada

```
Twilio ──audio──▶ WebSocket (NestJS) ──▶ STT (Deepgram / ElevenLabs)
   ▲                                          │ texto
   │                                          ▼
   └──audio μ-law── TTS (ElevenLabs) ◀── LLM (OpenAI, streaming)
                                              │
                                   RAG + tools (webhooks, escalado)
```

1. Twilio recibe o lanza la llamada y abre un WebSocket con el backend.
2. El audio del usuario se transcribe en tiempo real (STT).
3. El LLM genera la respuesta en streaming con el prompt del agente, el historial y el conocimiento recuperado.
4. La respuesta se convierte en voz (TTS) y vuelve a Twilio.
5. Si el usuario interrumpe, se corta el audio en curso y se reinicia el turno (barge-in).

## Funcionalidades principales

| Módulo | Qué hace |
| --- | --- |
| `streams/` | Gateway WebSocket de voz en tiempo real: STT → LLM → TTS, interrupciones y silencios |
| `knowledge-base/` | RAG: extracción de PDF, web y texto → limpieza → chunking con solape → embeddings (`text-embedding-3-small`) → búsqueda por similitud coseno filtrada por agente |
| `webhook-actions/` | Function calling: los webhooks del cliente (Make, Shopify…) se exponen al LLM como tools |
| `learning/` | Evaluación diaria de llamadas reales con un LLM como juez; las mejores se guardan como dataset para fine-tuning |
| `agents/`, `users/`, `auth/` | Gestión de agentes, usuarios y autenticación con Firebase |
| `stripe/`, `plan-limits/` | Suscripciones y facturación por uso |
| `metrics/` | Métricas de llamadas para el dashboard |
| `support-chat/` | Chat de soporte con IA |

## Stack

- **Backend:** NestJS 11, TypeScript, WebSockets
- **IA:** OpenAI (chat, embeddings), Deepgram (STT), ElevenLabs (STT/TTS)
- **Telefonía:** Twilio
- **Datos:** Firebase / Firestore, Firebase Storage
- **Pagos:** Stripe
- **Observabilidad y seguridad:** Sentry, Helmet, rate limiting (Throttler), Swagger
- **Despliegue:** Render con entornos dev, preprod y prod (`render.yaml`)

## Puesta en marcha

```bash
yarn install
cp env.example .env   # rellena las variables
yarn start:dev
```

Las claves (OpenAI, Twilio, ElevenLabs, Deepgram, Stripe, Firebase…) se configuran solo por variables de entorno; ver `env.example` y `CONFIGURACION_VARIABLES_ENTORNO.md`.

## Scripts útiles

| Comando | Uso |
| --- | --- |
| `yarn start:dev` | Desarrollo con recarga |
| `yarn build` / `yarn start:prod` | Compilar y arrancar en producción |
| `yarn test` | Tests con Jest |
| `yarn lint` | Linter |

## Repositorios relacionados

- [LlamaloIA](https://github.com/GabrielHdezAlv/LlamaloIA) — frontend en Angular 19
- [LlamaloIABackend](https://github.com/GabrielHdezAlv/LlamaloIABackend) — primera versión del backend en .NET 9

---

Autor: [Gabriel Hernández Álvarez](https://github.com/GabrielHdezAlv) — CTO y cofundador de LlamaloAI
