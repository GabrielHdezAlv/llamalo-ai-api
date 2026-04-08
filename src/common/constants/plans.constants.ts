export const PLAN_LIMITS = {
  /** Gratis; el slug legacy `basic` se migra a `gratis` en usuarios */
  gratis: {
    name: 'Gratis',
    price: 0,
    minutesLimit: 100,
  },
  pro: {
    name: 'Pro',
    price: 29,
    minutesLimit: 500,
  },
  premium: {
    name: 'Premium',
    price: 99,
    minutesLimit: 2000,
  },
};

export type PlanType = keyof typeof PLAN_LIMITS;

export const DEFAULT_PLAN: PlanType = 'gratis';

/** Valores antiguos de `user.plan` que equivalen al plan gratuito */
export const LEGACY_FREE_PLAN_SLUGS = ['basic', 'free'] as const;

/** Plan Premium: minutos ilimitados para cupo de voz (no aplica techo numérico). */
export function isUnlimitedPlan(plan?: string): boolean {
  return plan === 'premium';
}
