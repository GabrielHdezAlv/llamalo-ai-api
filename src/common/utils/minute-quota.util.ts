import {
  isUnlimitedPlan,
  normalizePlanSlug,
} from '../constants/plans.constants';
import {
  getCalendarMonthKey,
  resolveMetricsTimezoneFromUser,
} from '../../metrics/metrics-calendar.util';

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
    billingChurnLocked?: boolean;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionStatus?: string | null;
  },
  options?: { effectiveMinutesLimit?: number },
): MinuteQuotaSnapshot {
  const tz = resolveMetricsTimezoneFromUser(
    userData as Record<string, unknown>,
  );
  const currentMonth = getCalendarMonthKey(tz);
  const usedMinutes = userData.minutesByMonth?.[currentMonth] || 0;

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
  const extraMinutes = userData.extraMinutes || 0;
  /** Alineado con `computeAutoExtraMinutesAfterSync`: el cupo cuenta extras implícitos aunque Firestore aún no haya sincronizado. */
  const imputedExtra = Math.max(
    extraMinutes,
    Math.max(0, Math.ceil(usedMinutes) - planLimit),
  );
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
