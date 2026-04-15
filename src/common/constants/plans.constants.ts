/** Metadatos de un plan (catálogo + límites de uso). */
export type PlanLimitsEntry = {
  name: string;
  price: number;
  currency: string;
  minutesLimit: number;
  /** Precio por minuto extra (EUR). */
  extraPerMinuteEur: number;
  agents: number;
  indexedUrls: number;
  documentsMax: number;
  maxDocSizeMb: number;
  /** Almacenamiento total conocimiento (MB). */
  storageTotalMb: number;
  panelAnalytics: string;
  integrations: string;
  support: string;
  betaAccess: boolean;
  /** Máx. acciones webhook (Make) por agente; 0 = sin acceso. */
  makeWebhookActionsMax: number;
  /** Máx. ejecuciones de webhooks distintas por llamada (anti-abuso). */
  makeWebhookExecutionsPerCallMax: number;
};

/** Duración del trial en cuenta gratuita (mismas capacidades técnicas que Starter). */
export const TRIAL_DURATION_DAYS = 7;

/**
 * Límites técnicos cuando el trial de 7 días expiró y el usuario sigue en `gratis`
 * (debe pasar a plan de pago para seguir usando el producto).
 */
export const EXPIRED_TRIAL_TECH_LIMITS: PlanLimitsEntry = {
  name: 'Gratis (trial expirado)',
  price: 0,
  currency: 'EUR',
  minutesLimit: 0,
  extraPerMinuteEur: 0,
  agents: 0,
  indexedUrls: 0,
  documentsMax: 0,
  maxDocSizeMb: 0,
  storageTotalMb: 0,
  panelAnalytics: '—',
  integrations: '—',
  support: '—',
  betaAccess: false,
  makeWebhookActionsMax: 0,
  makeWebhookExecutionsPerCallMax: 0,
};

export const PLAN_LIMITS = {
  /**
   * Catálogo “gratis”: minutos por defecto en alta; durante trial activo el backend
   * aplica los mismos tech limits que Starter (ver PlanLimitsService).
   */
  gratis: {
    name: 'Gratis',
    price: 0,
    currency: 'EUR',
    minutesLimit: 100,
    extraPerMinuteEur: 0,
    agents: 1,
    indexedUrls: 10,
    documentsMax: 5,
    maxDocSizeMb: 10,
    storageTotalMb: 100,
    panelAnalytics: 'Básico',
    integrations: 'Make (webhooks)',
    support: 'Email',
    betaAccess: false,
    makeWebhookActionsMax: 3,
    makeWebhookExecutionsPerCallMax: 3,
  },
  starter: {
    name: 'Starter',
    price: 29,
    currency: 'EUR',
    minutesLimit: 45,
    extraPerMinuteEur: 0.23,
    agents: 1,
    indexedUrls: 10,
    documentsMax: 5,
    maxDocSizeMb: 10,
    storageTotalMb: 100,
    panelAnalytics: 'Básico',
    integrations: 'Make (webhooks)',
    support: 'Email',
    betaAccess: false,
    makeWebhookActionsMax: 3,
    makeWebhookExecutionsPerCallMax: 3,
  },
  growth: {
    name: 'Growth',
    price: 79,
    currency: 'EUR',
    minutesLimit: 200,
    extraPerMinuteEur: 0.2,
    agents: 2,
    indexedUrls: 50,
    documentsMax: 20,
    maxDocSizeMb: 15,
    storageTotalMb: 400,
    panelAnalytics: 'Avanzado',
    integrations:
      'Shopify / WooCommerce, Make (webhooks)',
    support: 'Prioritario',
    betaAccess: false,
    makeWebhookActionsMax: 15,
    makeWebhookExecutionsPerCallMax: 6,
  },
  scale: {
    name: 'Scale',
    price: 169,
    currency: 'EUR',
    minutesLimit: 500,
    extraPerMinuteEur: 0.18,
    agents: 5,
    indexedUrls: 150,
    documentsMax: 60,
    maxDocSizeMb: 25,
    storageTotalMb: 1536,
    panelAnalytics: 'Completo + exportación',
    integrations:
      'Shopify / WooCommerce, Make (webhooks), CRM + webhooks',
    support: 'Dedicado',
    betaAccess: true,
    makeWebhookActionsMax: 50,
    makeWebhookExecutionsPerCallMax: 10,
  },
} as const satisfies Record<string, PlanLimitsEntry>;

export type PlanType = keyof typeof PLAN_LIMITS;

export const DEFAULT_PLAN: PlanType = 'gratis';

/** Valores antiguos de `user.plan` que equivalen al plan gratuito */
export const LEGACY_FREE_PLAN_SLUGS = ['basic', 'free'] as const;

/**
 * Slugs de pago antiguos (antes de Starter / Growth / Scale).
 * `pro` → Starter; `premium` → Scale (tier superior anterior).
 */
export const LEGACY_PAID_PLAN_SLUGS = {
  pro: 'starter',
  premium: 'scale',
} as const satisfies Record<string, PlanType>;

/** Resuelve slug almacenado en usuario al catálogo actual. */
export function normalizePlanSlug(plan?: string | null): PlanType {
  if (!plan || String(plan).trim() === '') return DEFAULT_PLAN;
  const p = String(plan).trim();
  if (p in LEGACY_PAID_PLAN_SLUGS) {
    return LEGACY_PAID_PLAN_SLUGS[p as keyof typeof LEGACY_PAID_PLAN_SLUGS];
  }
  if (p in PLAN_LIMITS && p !== '__proto__') return p as PlanType;
  if ((LEGACY_FREE_PLAN_SLUGS as readonly string[]).includes(p)) {
    return DEFAULT_PLAN;
  }
  return DEFAULT_PLAN;
}

/** Plan Premium antiguo: minutos ilimitados para cupo de voz. Ya no existe en catálogo; solo legacy hasta migrar usuarios. */
export function isUnlimitedPlan(plan?: string): boolean {
  return plan === 'premium';
}
