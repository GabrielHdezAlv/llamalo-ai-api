/**
 * Inicialización de Sentry para el backend (NestJS).
 *
 * Este archivo DEBE ser el primer import de `main.ts` para que los
 * instrumentadores automáticos de Sentry envuelvan módulos nativos de Node
 * (http, https, etc.) antes de que el resto del código los cargue.
 *
 * Variables de entorno usadas:
 *  - SENTRY_DSN            → DSN del proyecto backend. Si no existe, Sentry
 *                            queda deshabilitado (útil en tests/local sin red).
 *  - SENTRY_ENVIRONMENT    → fuerza el entorno en Sentry. Si falta, cae a
 *                            NODE_ENV o 'development'.
 *  - SENTRY_RELEASE        → SHA de commit. Si no está definido, se usa
 *                            RENDER_GIT_COMMIT (lo inyecta Render
 *                            automáticamente en todos los servicios).
 *  - SENTRY_TRACES_SAMPLE_RATE → override manual del sample rate (0..1).
 */

import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN?.trim();
const env =
  process.env.SENTRY_ENVIRONMENT?.trim() ||
  process.env.NODE_ENV?.trim() ||
  'development';

const isProd = env === 'production' || env === 'prod';

const defaultTracesRate = isProd ? 0.1 : 1.0;
const tracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE
  ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
  : defaultTracesRate;

Sentry.init({
  dsn,
  enabled: !!dsn,
  environment: env,
  release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT,

  integrations: [nodeProfilingIntegration()],

  tracesSampleRate,
  profilesSampleRate: 1.0,

  sendDefaultPii: false,

  beforeSend(event) {
    const url = event.request?.url ?? '';
    if (url.includes('/health') || url.includes('/favicon')) {
      return null;
    }
    return event;
  },
});

if (!dsn) {
  console.warn(
    '⚠️  SENTRY_DSN no está definido. La observabilidad de errores está desactivada.',
  );
} else {
  console.log(`🛡️  Sentry inicializado (environment=${env})`);
}
