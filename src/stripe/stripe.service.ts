import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';
import { getFirestore } from '../firebase/firebase.config';
import {
  PLAN_LIMITS,
  PlanType,
} from '../common/constants/plans.constants';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

const PAID_PLANS: PlanType[] = ['starter', 'growth', 'scale'];

/** Cobro pendiente: mantenemos plan e id de suscripción para que el usuario pague vía portal. */
const STRIPE_BLOCKED_SUB_STATUSES = new Set([
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
]);

type CheckoutSessionLike = {
  id?: string;
  metadata?: { userId?: string; plan?: string } | null;
  client_reference_id?: string | null;
  customer?: string | { id?: string } | null;
  subscription?: string | { id?: string } | null;
};

type SubscriptionLike = {
  id: string;
  status: string;
  metadata?: { userId?: string; plan?: string } | null;
  customer?: string | { id?: string };
  items?: { data?: Array<{ price?: { id?: string } }> };
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly firestore = getFirestore();
  private client: InstanceType<typeof Stripe> | null = null;

  constructor(private readonly planLimitsService: PlanLimitsService) {}

  private getStripe(): InstanceType<typeof Stripe> {
    if (!this.client) {
      const key = process.env.STRIPE_SECRET_KEY?.trim();
      if (!key) {
        throw new BadRequestException(
          'Stripe no está configurado (STRIPE_SECRET_KEY).',
        );
      }
      this.client = new Stripe(key);
    }
    return this.client;
  }

  private priceIdForPlan(plan: PlanType): string {
    const envMap: Record<PlanType, string | undefined> = {
      gratis: undefined,
      starter: process.env.STRIPE_PRICE_STARTER,
      growth: process.env.STRIPE_PRICE_GROWTH,
      scale: process.env.STRIPE_PRICE_SCALE,
    };
    const id = envMap[plan];
    if (!id?.trim()) {
      throw new BadRequestException(
        `No hay STRIPE_PRICE configurado para el plan: ${plan}`,
      );
    }
    return id.trim();
  }

  /**
   * Starter: 7 días de prueba en Stripe sin tarjeta si el periodo de prueba de cuenta `gratis` ya terminó.
   * Si el trial de cuenta sigue activo, no se duplica periodo gratuito en Stripe (suscripción sin trial en checkout).
   * Growth/Scale: cobro al confirmar, sin periodo de prueba.
   */
  async createCheckoutSession(params: {
    userId: string;
    plan: PlanType;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string | null; sessionId: string }> {
    if (!PAID_PLANS.includes(params.plan)) {
      throw new BadRequestException('Plan no válido para checkout');
    }
    const priceId = this.priceIdForPlan(params.plan);
    const stripe = this.getStripe();

    const userSnap = await this.firestore
      .collection('users')
      .doc(params.userId)
      .get();
    const userData = userSnap.exists ? userSnap.data() : undefined;
    const accountTrialActive =
      !!userData && this.planLimitsService.isTrialActive(userData);

    const useStarterStripeTrial =
      params.plan === 'starter' && !accountTrialActive;

    const subscriptionData: {
      metadata: { userId: string; plan: string };
      trial_period_days?: number;
    } = {
      metadata: {
        userId: params.userId,
        plan: params.plan,
      },
      ...(useStarterStripeTrial ? { trial_period_days: 7 } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.userId,
      metadata: {
        userId: params.userId,
        plan: params.plan,
      },
      subscription_data: subscriptionData,
      ...(useStarterStripeTrial
        ? { payment_method_collection: 'if_required' as const }
        : {}),
    });
    return { url: session.url, sessionId: session.id };
  }

  async createBillingPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string | null }> {
    const stripe = this.getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return { url: session.url };
  }

  /** Portal de facturación usando el cliente Stripe guardado en Firestore (no confiar en el body). */
  async createBillingPortalSessionForUser(params: {
    userId: string;
    returnUrl: string;
  }): Promise<{ url: string | null }> {
    const snap = await this.firestore.collection('users').doc(params.userId).get();
    if (!snap.exists) {
      throw new BadRequestException('Usuario no encontrado');
    }
    const custId = (snap.data() as { stripeCustomerId?: string | null })
      ?.stripeCustomerId;
    if (!custId || typeof custId !== 'string' || !custId.trim()) {
      throw new BadRequestException(
        'No hay facturación asociada. Suscríbete primero desde la página de planes.',
      );
    }
    return this.createBillingPortalSession({
      customerId: custId.trim(),
      returnUrl: params.returnUrl,
    });
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) {
      this.logger.warn('STRIPE_WEBHOOK_SECRET no configurado; webhook ignorado.');
      return;
    }
    if (!signature) {
      throw new BadRequestException('Falta cabecera stripe-signature');
    }
    const stripe = this.getStripe();
    let event: { type: string; data: { object: unknown } };
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
      ) as { type: string; data: { object: unknown } };
    } catch (err) {
      this.logger.warn(`Webhook Stripe firma inválida: ${(err as Error).message}`);
      throw new BadRequestException('Firma webhook inválida');
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        await this.applyPlanFromSession(
          event.data.object as CheckoutSessionLike,
        );
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await this.syncSubscriptionToUser(
          event.data.object as SubscriptionLike,
        );
        break;
      }
      default:
        break;
    }
  }

  private async applyPlanFromSession(session: CheckoutSessionLike): Promise<void> {
    const userId =
      session.metadata?.userId ||
      session.client_reference_id ||
      undefined;
    const plan = session.metadata?.plan as PlanType | undefined;
    if (!userId || !plan || !PLAN_LIMITS[plan]) {
      this.logger.warn(
        `checkout.session.completed sin userId/plan válidos: ${session.id}`,
      );
      return;
    }
    const lim = PLAN_LIMITS[plan];
    const customerId =
      typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
    const subId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

    const stripe = this.getStripe();
    let stripeSubscriptionStatus: string | null = null;
    if (subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        stripeSubscriptionStatus = sub.status;
      } catch (e) {
        this.logger.warn(
          `No se pudo leer suscripción ${subId}: ${(e as Error).message}`,
        );
      }
    }

    const payload: Record<string, unknown> = {
      plan,
      minutesLimit: lim.minutesLimit,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subId ?? null,
      stripeSubscriptionStatus,
      planSelectionCompleted: true,
      updatedAt: new Date(),
      trialEndsAt: admin.firestore.FieldValue.delete(),
    };

    await this.firestore
      .collection('users')
      .doc(userId)
      .set(payload, { merge: true });
    this.logger.log(`Plan ${plan} aplicado a usuario ${userId} tras checkout.`);
  }

  private async syncSubscriptionToUser(sub: SubscriptionLike): Promise<void> {
    const userId = sub.metadata?.userId;
    if (!userId) {
      const custId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (!custId) return;
      const q = await this.firestore
        .collection('users')
        .where('stripeCustomerId', '==', custId)
        .limit(1)
        .get();
      if (q.empty) return;
      const doc = q.docs[0];
      await this.updateUserFromSubscription(doc.id, sub);
      return;
    }
    await this.updateUserFromSubscription(userId, sub);
  }

  private async updateUserFromSubscription(
    userId: string,
    sub: SubscriptionLike,
  ): Promise<void> {
    const status = sub.status;

    if (status === 'canceled' || status === 'incomplete_expired') {
      await this.firestore
        .collection('users')
        .doc(userId)
        .set(
          {
            plan: 'gratis',
            minutesLimit: PLAN_LIMITS.gratis.minutesLimit,
            stripeSubscriptionId: null,
            stripeSubscriptionStatus: null,
            updatedAt: new Date(),
          },
          { merge: true },
        );
      return;
    }

    const planFromSub = (): PlanType | undefined => {
      let plan = sub.metadata?.plan as PlanType | undefined;
      if (!plan && sub.items?.data?.[0]?.price?.id) {
        plan = this.planFromPriceId(sub.items.data[0].price.id);
      }
      return plan;
    };

    if (STRIPE_BLOCKED_SUB_STATUSES.has(status)) {
      const plan = planFromSub();
      if (!plan || !PLAN_LIMITS[plan]) {
        this.logger.warn(
          `No se pudo mapear plan para suscripción bloqueada ${sub.id}`,
        );
        return;
      }
      const lim = PLAN_LIMITS[plan];
      await this.firestore
        .collection('users')
        .doc(userId)
        .set(
          {
            plan,
            minutesLimit: lim.minutesLimit,
            stripeSubscriptionId: sub.id,
            stripeSubscriptionStatus: status,
            planSelectionCompleted: true,
            updatedAt: new Date(),
          },
          { merge: true },
        );
      return;
    }

    const plan = planFromSub();
    if (!plan || !PLAN_LIMITS[plan]) {
      this.logger.warn(`No se pudo mapear plan para suscripción ${sub.id}`);
      return;
    }
    const lim = PLAN_LIMITS[plan];
    await this.firestore
      .collection('users')
      .doc(userId)
      .set(
        {
          plan,
          minutesLimit: lim.minutesLimit,
          stripeSubscriptionId: sub.id,
          stripeSubscriptionStatus: status,
          planSelectionCompleted: true,
          updatedAt: new Date(),
        },
        { merge: true },
      );
  }

  private planFromPriceId(priceId: string): PlanType | undefined {
    const p = priceId.trim();
    if (p === process.env.STRIPE_PRICE_STARTER?.trim()) return 'starter';
    if (p === process.env.STRIPE_PRICE_GROWTH?.trim()) return 'growth';
    if (p === process.env.STRIPE_PRICE_SCALE?.trim()) return 'scale';
    return undefined;
  }
}
