import { BadRequestException } from '@nestjs/common';

/**
 * Host Llamalo permitido como destino de webhook según despliegue.
 * - Establece `LLAMALO_ENV` en Render (o similar): `development` | `preproduction` | `production`
 * - Si no está definido: con `NODE_ENV !== 'production'` → dev; en producción → app.
 * - Preprod con `NODE_ENV=production` debe usar `LLAMALO_ENV=preproduction` para permitir preprod.llamalo.ai.
 */
const LLAMALO_ENV_TO_HOST: Record<string, string> = {
  development: 'dev.llamalo.ai',
  dev: 'dev.llamalo.ai',
  preproduction: 'preprod.llamalo.ai',
  preprod: 'preprod.llamalo.ai',
  production: 'app.llamalo.ai',
  prod: 'app.llamalo.ai',
};

function resolveAllowedLlamaloHosts(): Set<string> {
  const set = new Set<string>();
  const explicit = process.env.LLAMALO_ENV?.trim().toLowerCase();
  if (explicit && LLAMALO_ENV_TO_HOST[explicit]) {
    set.add(LLAMALO_ENV_TO_HOST[explicit]);
  } else if (process.env.NODE_ENV !== 'production') {
    set.add('dev.llamalo.ai');
  } else {
    set.add('app.llamalo.ai');
  }
  const extra = process.env.WEBHOOK_EXTRA_ALLOWED_HOSTS?.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (extra) {
    for (const h of extra) {
      set.add(h);
    }
  }
  return set;
}

/** Hostnames que no deben usarse como destino de webhooks (mitigación SSRF). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function isBlockedIpv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (oct.some((n) => n > 255)) return true;
  const [a, b] = oct;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Valida URL pública HTTPS para webhooks de usuario (Make, etc.).
 * @param allowHttpLocalhost - Solo desarrollo: permite http://127.0.0.1 / localhost
 */
export function assertPublicHttpsWebhookUrl(
  raw: string,
  options?: { allowHttpLocalhost?: boolean },
): void {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new BadRequestException('La URL del webhook es obligatoria.');
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new BadRequestException('La URL del webhook no es válida.');
  }

  const allowLocal =
    options?.allowHttpLocalhost === true &&
    process.env.NODE_ENV !== 'production';

  const host = u.hostname.toLowerCase();
  const allowedLlamaloHosts = resolveAllowedLlamaloHosts();
  const isTrustedLlamaloHost = allowedLlamaloHosts.has(host);

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    if (!(allowLocal && (host === 'localhost' || host === '127.0.0.1'))) {
      if (!isTrustedLlamaloHost) {
        throw new BadRequestException(
          'No se permiten URLs locales o internas como webhook.',
        );
      }
    }
  }

  if (isBlockedIpv4(host)) {
    if (!(allowLocal && host === '127.0.0.1')) {
      if (!isTrustedLlamaloHost) {
        throw new BadRequestException(
          'No se permiten direcciones IP privadas como webhook.',
        );
      }
    }
  }

  if (u.protocol !== 'https:') {
    if (
      allowLocal &&
      u.protocol === 'http:' &&
      (host === 'localhost' || host === '127.0.0.1')
    ) {
      return;
    }
    throw new BadRequestException('La URL del webhook debe usar HTTPS.');
  }

  if (!host || u.username || u.password) {
    throw new BadRequestException('La URL del webhook no es válida.');
  }
}
