import { isUnlimitedPlan } from '../constants/plans.constants';

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

export function computeMinuteQuotaFromUserData(
  userData: {
    plan?: string;
    minutesLimit?: number;
    extraMinutes?: number;
    minutesByMonth?: Record<string, number>;
  },
  options?: { effectiveMinutesLimit?: number },
): MinuteQuotaSnapshot {
  const currentMonth = new Date().toISOString().slice(0, 7);
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
  const totalLimit = planLimit + extraMinutes;
  const availableMinutes = Math.max(0, totalLimit - usedMinutes);
  return {
    hasMinutes: availableMinutes > 0,
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
