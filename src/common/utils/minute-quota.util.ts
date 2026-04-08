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

export function computeMinuteQuotaFromUserData(userData: {
  minutesLimit?: number;
  extraMinutes?: number;
  minutesByMonth?: Record<string, number>;
}): MinuteQuotaSnapshot {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const usedMinutes = userData.minutesByMonth?.[currentMonth] || 0;
  const planLimit = userData.minutesLimit ?? 100;
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
