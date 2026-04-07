export const PLAN_LIMITS = {
  basic: {
    name: 'Básico',
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

export const DEFAULT_PLAN: PlanType = 'basic';
