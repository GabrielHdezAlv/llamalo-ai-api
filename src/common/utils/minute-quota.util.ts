import {
  isUnlimitedPlan,
  normalizePlanSlug,
} from '../constants/plans.constants';
import {
  getCalendarMonthKey,
  resolveMetricsTimezoneFromUser,
} from '../../metrics/metrics-calendar.util';

/**
 * Clave de `minutesByMonth` para el periodo de uso: periodo de suscripción Stripe (`p{startUnix}`)
 * si está disponible; si no, `YYYY-MM` (mes calendario de negocio).
 */
export function getVoiceUsageStorageKey(
  userData: {
    metricsCalendarTimezone?: string;
    stripeCurrentPeriodStart?: number | null;
  },
): string {
  const tz = resolveMetricsTimezoneFromUser(
    userData as Record<string, unknown>,
  );
  const t = userData.stripeCurrentPeriodStart;
  if (t != null && Number.isFinite(Number(t))) {
    return `p${Number(t)}`;
  }
  return getCalendarMonthKey(tz);
}

/**
 * Cálculo unificado del cupo mensual de minutos (plan + extras vs consumo del mes).
 * Usar la misma lógica en UsersService, StreamsGateway y cualquier guard de API.
 */
export type MinuteQuotaSnapshot = {
  hasMinutes: boolean;
  availableMinutes: number;
  usedMinutes: number;
  totalLimit: number;
};

const PAID_SLUGS = new Set(['starter', 'growth', 'scale']);

/** Solo planes de pago pueden acumular `extraMinutes` en Firestore (bonificación / ajuste por consumo). Plan `gratis`, `sin_plan`, etc.: siempre 0. */
export function planAllowsExtraMinutesPool(plan?: string): boolean {
  return PAID_SLUGS.has(normalizePlanSlug(plan));
}

/**
 * Plan Starter/Growth/Scale con suscripción Stripe activa: el sobrepaso se factura
 * (minutos extra / metered); no bloquear llamadas por cupo agotado.
 */
export function allowsMeteredVoiceOverage(userData: {
  plan?: string;
  billingChurnLocked?: boolean;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
}): boolean {
  if (userData.billingChurnLocked === true) {
    return false;
  }
  const slug = normalizePlanSlug(userData.plan);
  if (!PAID_SLUGS.has(slug)) {
    return false;
  }
  if (!userData.stripeSubscriptionId?.trim()) {
    return false;
  }
  const st = (userData.stripeSubscriptionStatus || '').trim().toLowerCase();
  return st === 'active' || st === 'trialing';
}

export function computeMinuteQuotaFromUserData(
  userData: {
    plan?: string;
    minutesLimit?: number;
    extraMinutes?: number;
    minutesByMonth?: Record<string, number>;
    metricsCalendarTimezone?: string;
    stripeCurrentPeriodStart?: number | null;
    billingChurnLocked?: boolean;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionStatus?: string | null;
  },
  options?: { effectiveMinutesLimit?: number },
): MinuteQuotaSnapshot {
  const tz = resolveMetricsTimezoneFromUser(
    userData as Record<string, unknown>,
  );
  const usageKey = getVoiceUsageStorageKey({
    metricsCalendarTimezone: userData.metricsCalendarTimezone,
    stripeCurrentPeriodStart: userData.stripeCurrentPeriodStart,
  });
  const usedMinutes = userData.minutesByMonth?.[usageKey] || 0;

  if (isUnlimitedPlan(userData.plan)) {
    return {
      hasMinutes: true,
      availableMinutes: Number.MAX_SAFE_INTEGER,
      usedMinutes,
      totalLimit: Number.MAX_SAFE_INTEGER,
    };
  }

  const planLimit =
    options?.effectiveMinutesLimit !== undefined
      ? options.effectiveMinutesLimit
      : (userData.minutesLimit ?? 100);
  const poolOk = planAllowsExtraMinutesPool(userData.plan);
  const extraMinutes = poolOk ? userData.extraMinutes || 0 : 0;
  /** Alineado con `computeAutoExtraMinutesAfterSync`; gratis/sin_plan no usan pool de extras. */
  const imputedExtra = poolOk
    ? Math.max(
        extraMinutes,
        Math.max(0, Math.ceil(usedMinutes) - planLimit),
      )
    : 0;
  const totalLimit = planLimit + imputedExtra;
  const availableMinutes = Math.max(0, totalLimit - usedMinutes);
  const metered = allowsMeteredVoiceOverage(userData);
  return {
    hasMinutes: availableMinutes > 0 || metered,
    availableMinutes,
    usedMinutes,
    totalLimit,
  };
}

/**
 * Si el consumo supera el límite base del plan, sube `extraMinutes` para cubrir el
 * sobrepaso (sin Stripe). Idempotente: no reduce extras ya concedidos.
 * Planes sin pool de pago (`gratis`, `sin_plan`, …): `extraMinutes` se fuerza a 0.
 */
export function computeAutoExtraMinutesAfterSync(params: {
  plan?: string;
  minutesLimit?: number;
  extraMinutes?: number;
  usedMinutes: number;
}): { newExtraMinutes: number; didAdjust: boolean } {
  if (isUnlimitedPlan(params.plan)) {
    const cur = params.extraMinutes ?? 0;
    return { newExtraMinutes: cur, didAdjust: false };
  }
  if (!planAllowsExtraMinutesPool(params.plan)) {
    const cur = params.extraMinutes ?? 0;
    return { newExtraMinutes: 0, didAdjust: cur !== 0 };
  }
  const planLimit = params.minutesLimit ?? 100;
  const currentExtra = params.extraMinutes ?? 0;
  const used = params.usedMinutes;
  const requiredExtra = Math.max(0, Math.ceil(used) - planLimit);
  const newExtra = Math.max(currentExtra, requiredExtra);
  return {
    newExtraMinutes: newExtra,
    didAdjust: newExtra !== currentExtra,
  };
}
