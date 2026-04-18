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
import { EmailService } from '../auth/email.service';

const PAID_PLANS: PlanType[] = ['starter', 'growth', 'scale'];

type BillingInterval = 'month' | 'year';

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

type StripeInvoiceRetrieved = Awaited<
  ReturnType<InstanceType<typeof Stripe>['invoices']['retrieve']>
> & {
  /** Presente en facturas de suscripción (Stripe typings a veces omiten el campo). */
  subscription?: string | { id?: string; metadata?: { userId?: string } } | null;
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly firestore = getFirestore();
  private client: InstanceType<typeof Stripe> | null = null;

  constructor(private readonly emailService: EmailService) {}

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

  private priceIdForPlan(plan: PlanType, interval: BillingInterval): string {
    type PaidCatalog = Exclude<PlanType, 'gratis' | 'sin_plan'>;
    const monthly: Record<PaidCatalog, string | undefined> = {
      starter: process.env.STRIPE_PRICE_STARTER,
      growth: process.env.STRIPE_PRICE_GROWTH,
      scale: process.env.STRIPE_PRICE_SCALE,
    };
    const annual: Record<PaidCatalog, string | undefined> = {
      starter: process.env.STRIPE_PRICE_STARTER_ANNUAL,
      growth: process.env.STRIPE_PRICE_GROWTH_ANNUAL,
      scale: process.env.STRIPE_PRICE_SCALE_ANNUAL,
    };
    const id =
      interval === 'year'
        ? annual[plan as PaidCatalog]
        : monthly[plan as PaidCatalog];
    if (!id?.trim()) {
      const suffix = interval === 'year' ? '_ANNUAL' : '';
      throw new BadRequestException(
        `No hay STRIPE_PRICE${suffix} configurado para el plan: ${plan}`,
      );
    }
    return id.trim();
  }

  /**
   * Precio metered (minutos extra) alineado con el plan base y el periodo de facturación.
   * Requiere STRIPE_PRICE_{PLAN}_METERED y STRIPE_PRICE_{PLAN}_METERED_ANNUAL en env.
   */
  private meteredPriceIdForPlan(
    plan: PlanType,
    interval: BillingInterval,
  ): string {
    type PaidCatalog = Exclude<PlanType, 'gratis' | 'sin_plan'>;
    const monthly: Record<PaidCatalog, string | undefined> = {
      starter: process.env.STRIPE_PRICE_STARTER_METERED,
      growth: process.env.STRIPE_PRICE_GROWTH_METERED,
      scale: process.env.STRIPE_PRICE_SCALE_METERED,
    };
    const annual: Record<PaidCatalog, string | undefined> = {
      starter: process.env.STRIPE_PRICE_STARTER_METERED_ANNUAL,
      growth: process.env.STRIPE_PRICE_GROWTH_METERED_ANNUAL,
      scale: process.env.STRIPE_PRICE_SCALE_METERED_ANNUAL,
    };
    const id =
      interval === 'year'
        ? annual[plan as PaidCatalog]
        : monthly[plan as PaidCatalog];
    if (!id?.trim()) {
      const hint =
        interval === 'year'
          ? 'STRIPE_PRICE_*_METERED_ANNUAL'
          : 'STRIPE_PRICE_*_METERED';
      throw new BadRequestException(
        `No hay precio metered (${hint}) configurado para el plan: ${plan}`,
      );
    }
    return id.trim();
  }

  /**
   * Starter: `starterMode: 'trial'` → 7 días en Stripe con tarjeta obligatoria en Checkout para poder
   * cobrar al finalizar la prueba si el usuario no cancela. `pay` → suscripción sin trial.
   * Siempre `payment_method_collection: 'always'`.
   */
  async createCheckoutSession(params: {
    userId: string;
    plan: PlanType;
    successUrl: string;
    cancelUrl: string;
    starterMode?: 'trial' | 'pay';
    /** Por defecto mensual; `year` usa STRIPE_PRICE_*_ANNUAL. */
    billingInterval?: BillingInterval;
  }): Promise<{ url: string | null; sessionId: string }> {
    if (!PAID_PLANS.includes(params.plan)) {
      throw new BadRequestException('Plan no válido para checkout');
    }
    if (
      params.starterMode != null &&
      params.plan !== 'starter'
    ) {
      throw new BadRequestException(
        'starterMode solo es válido cuando plan es starter',
      );
    }

    let billingInterval: BillingInterval = 'month';
    if (params.billingInterval != null) {
      if (params.billingInterval !== 'month' && params.billingInterval !== 'year') {
        throw new BadRequestException(
          'billingInterval debe ser month o year',
        );
      }
      billingInterval = params.billingInterval;
    }
    const priceId = this.priceIdForPlan(params.plan, billingInterval);
    const meteredPriceId = this.meteredPriceIdForPlan(
      params.plan,
      billingInterval,
    );
    const stripe = this.getStripe();

    const userSnap = await this.firestore
      .collection('users')
      .doc(params.userId)
      .get();
    const fd = userSnap.exists
      ? (userSnap.data() as {
          stripeCustomerId?: string | null;
          stripeStarterTrialEligible?: boolean;
        })
      : null;
    const existingCustomerId = fd?.stripeCustomerId?.trim();
    /** `false` si ya pagó o churn; ausente/true = puede trial Starter (solo cuentas nuevas). */
    const starterTrialEligible = fd?.stripeStarterTrialEligible !== false;

    const starterTrial =
      params.plan === 'starter' &&
      (params.starterMode ?? 'pay') === 'trial' &&
      starterTrialEligible;

    const subscriptionData: {
      metadata: { userId: string; plan: string };
      trial_period_days?: number;
    } = {
      metadata: {
        userId: params.userId,
        plan: params.plan,
      },
      ...(starterTrial ? { trial_period_days: 7 } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: priceId, quantity: 1 },
        { price: meteredPriceId, quantity: 1 },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.userId,
      metadata: {
        userId: params.userId,
        plan: params.plan,
      },
      subscription_data: subscriptionData,
      /** Trial €0 primero: igual exigir tarjeta para cargar al día 7 si siguen suscritos. */
      payment_method_collection: 'always',
      ...(existingCustomerId ? { customer: existingCustomerId } : {}),
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

  /**
   * Última factura con PDF (o página alojada) para descarga desde la cuenta.
   */
  async getLatestInvoiceDownloadForUser(userId: string): Promise<{
    pdfUrl: string | null;
    hostedInvoiceUrl: string | null;
    invoiceNumber: string | null;
    invoiceId: string | null;
  }> {
    const snap = await this.firestore.collection('users').doc(userId).get();
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

    const stripe = this.getStripe();
    const list = await stripe.invoices.list({
      customer: custId.trim(),
      limit: 20,
    });

    const candidates = list.data.filter((inv) => inv.status === 'paid');
    const pick =
      candidates.find((inv) => Boolean(inv.invoice_pdf)) ??
      candidates[0] ??
      list.data[0];

    if (!pick) {
      throw new BadRequestException('No hay facturas disponibles todavía.');
    }

    let invoice = pick;
    if (!invoice.invoice_pdf && !invoice.hosted_invoice_url) {
      try {
        invoice = await stripe.invoices.retrieve(invoice.id);
      } catch (e) {
        this.logger.warn(
          `No se pudo refrescar factura ${invoice.id}: ${(e as Error).message}`,
        );
      }
    }

    const pdfUrl = invoice.invoice_pdf ?? null;
    const hostedInvoiceUrl = invoice.hosted_invoice_url ?? null;
    if (!pdfUrl && !hostedInvoiceUrl) {
      throw new BadRequestException(
        'La última factura aún no tiene PDF disponible. Inténtalo más tarde o usa el portal de facturación.',
      );
    }

    return {
      pdfUrl,
      hostedInvoiceUrl,
      invoiceNumber: invoice.number ?? null,
      invoiceId: invoice.id ?? null,
    };
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
      /** Portal con «cambio al final del periodo»: Stripe adjunta Subscription Schedule. */
      case 'subscription_schedule.updated':
      case 'subscription_schedule.completed':
      case 'subscription_schedule.released': {
        await this.syncSubscriptionFromScheduleWebhookPayload(
          event.data.object,
        );
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        await this.sendInvoiceReceiptToCustomer(
          event.data.object as { id: string },
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Tras invoice.paid / invoice.payment_succeeded: envía por Resend enlace a factura y PDF.
   * No fiarse del payload del webhook: a veces viene sin `subscription`; se consulta la factura en la API.
   */
  private async sendInvoiceReceiptToCustomer(invoicePayload: {
    id: string;
  }): Promise<void> {
    const stripe = this.getStripe();
    let invoice: Awaited<
      ReturnType<InstanceType<typeof Stripe>['invoices']['retrieve']>
    >;
    try {
      invoice = await stripe.invoices.retrieve(invoicePayload.id, {
        expand: ['customer', 'subscription'],
      });
    } catch (e) {
      this.logger.warn(
        `No se pudo recuperar factura ${invoicePayload.id}: ${(e as Error).message}`,
      );
      return;
    }

    const subId = this.subscriptionIdFromInvoice(invoice);
    if (!subId) {
      this.logger.log(
        `Factura ${invoice.id} sin suscripción asociada; no se envía recibo (solo facturas de plan).`,
      );
      return;
    }

    let to = invoice.customer_email ?? null;
    if (!to && invoice.customer && typeof invoice.customer === 'object') {
      const c = invoice.customer as { deleted?: boolean; email?: string | null };
      if (!c.deleted && c.email) {
        to = c.email;
      }
    }

    if (!to?.trim()) {
      to = await this.emailFromSubscriptionUserMetadata(
        stripe,
        invoice,
        subId,
      );
    }

    if (!to?.trim()) {
      this.logger.warn(
        `Factura ${invoice.id}: sin email en Stripe ni en usuario Firestore; no se envía recibo`,
      );
      return;
    }

    const lockRef = this.firestore
      .collection('stripeInvoiceReceiptEmails')
      .doc(invoice.id);
    try {
      await lockRef.create({
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (this.isFirestoreAlreadyExists(e)) {
        this.logger.log(
          `Recibo de factura ${invoice.id} ya enviado o en proceso; omitiendo`,
        );
        return;
      }
      throw e;
    }

    const currency = (invoice.currency || 'eur').toUpperCase();
    const amountCents = invoice.amount_paid ?? 0;
    let amountFormatted: string;
    try {
      amountFormatted = new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: currency.length === 3 ? currency : 'EUR',
      }).format(amountCents / 100);
    } catch {
      amountFormatted = `${(amountCents / 100).toFixed(2)} ${currency}`;
    }

    try {
      await this.emailService.sendStripeInvoiceReceiptEmail({
        to: to.trim(),
        invoiceNumber: invoice.number,
        amountPaidFormatted: amountFormatted,
        currency,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdfUrl: invoice.invoice_pdf ?? null,
      });
      await lockRef.set(
        {
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          to: to.trim(),
        },
        { merge: true },
      );
      this.logger.log(`Recibo factura ${invoice.id} enviado a ${to.trim()}`);
    } catch (e) {
      try {
        await lockRef.delete();
      } catch {
        /* ignore */
      }
      this.logger.error(
        `Error enviando recibo de factura ${invoice.id}: ${(e as Error).message}`,
      );
    }
  }

  private subscriptionIdFromInvoice(invoice: StripeInvoiceRetrieved): string | null {
    const sub = invoice.subscription;
    if (sub == null) return null;
    if (typeof sub === 'string') return sub;
    if (typeof sub === 'object' && 'id' in sub && typeof (sub as { id: string }).id === 'string') {
      return (sub as { id: string }).id;
    }
    return null;
  }

  private isFirestoreAlreadyExists(err: unknown): boolean {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code: number | string }).code
        : undefined;
    return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
  }

  /** Email del usuario Llamalo si la suscripción tiene metadata.userId. */
  private async emailFromSubscriptionUserMetadata(
    stripe: InstanceType<typeof Stripe>,
    invoice: StripeInvoiceRetrieved,
    subId: string,
  ): Promise<string | null> {
    let userId: string | undefined;
    const subField = invoice.subscription;
    const subWithMeta = subField as { metadata?: { userId?: string } } | null;
    if (
      typeof subField === 'object' &&
      subField &&
      'metadata' in subField &&
      subWithMeta?.metadata?.userId
    ) {
      userId = subWithMeta.metadata.userId;
    } else {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        userId = sub.metadata?.userId;
      } catch (e) {
        this.logger.warn(
          `No se pudo leer suscripción ${subId} para email de recibo: ${(e as Error).message}`,
        );
        return null;
      }
    }
    if (!userId?.trim()) return null;
    try {
      const snap = await this.firestore.collection('users').doc(userId.trim()).get();
      const em = (snap.data() as { email?: string } | undefined)?.email;
      return em?.trim() || null;
    } catch (e) {
      this.logger.warn(
        `No se pudo leer email de usuario ${userId}: ${(e as Error).message}`,
      );
      return null;
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
      billingChurnLocked: false,
      stripeStarterTrialEligible: false,
    };

    await this.firestore
      .collection('users')
      .doc(userId)
      .set(payload, { merge: true });
    this.logger.log(`Plan ${plan} aplicado a usuario ${userId} tras checkout.`);
  }

  /**
   * Cuando el Customer Portal programa un cambio (p. ej. downgrade al fin de periodo), Stripe
   * gestiona un Subscription Schedule. Re-lee la suscripción por API y sincroniza plan en Firestore.
   * Incluir estos eventos en el endpoint del webhook en el Dashboard de Stripe.
   */
  private async syncSubscriptionFromScheduleWebhookPayload(
    schedulePayload: unknown,
  ): Promise<void> {
    const schedule = schedulePayload as {
      subscription?: string | { id?: string } | null;
    };
    const raw = schedule.subscription;
    const subId =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && raw.id
          ? raw.id
          : null;
    if (!subId?.trim()) {
      this.logger.log(
        'subscription_schedule: sin subscription asociada; omitiendo sync.',
      );
      return;
    }
    const stripe = this.getStripe();
    let full: Awaited<
      ReturnType<InstanceType<typeof Stripe>['subscriptions']['retrieve']>
    >;
    try {
      full = await stripe.subscriptions.retrieve(subId.trim());
    } catch (e) {
      this.logger.warn(
        `subscription_schedule: no se pudo cargar suscripción ${subId}: ${(e as Error).message}`,
      );
      return;
    }
    await this.syncSubscriptionToUser(full as unknown as SubscriptionLike);
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
            plan: 'sin_plan',
            minutesLimit: PLAN_LIMITS.sin_plan.minutesLimit,
            stripeSubscriptionId: null,
            stripeSubscriptionStatus: null,
            billingChurnLocked: true,
            stripeStarterTrialEligible: false,
            updatedAt: new Date(),
          },
          { merge: true },
        );
      return;
    }

    /**
     * El plan debe inferirse del precio activo de la suscripción. `metadata.plan` solo se fija en
     * Checkout y no lo actualiza el Customer Portal al cambiar de plan, así que priorizar metadata
     * dejaba Firestore en starter tras upgrade a Growth vía portal.
     */
    const planFromSub = (): PlanType | undefined => {
      const items = sub.items?.data;
      if (items?.length) {
        for (const item of items) {
          const priceId = item.price?.id;
          if (priceId) {
            const fromPrice = this.planFromPriceId(priceId);
            if (fromPrice && PLAN_LIMITS[fromPrice]) {
              return fromPrice;
            }
          }
        }
      }
      const fromMeta = sub.metadata?.plan as PlanType | undefined;
      if (fromMeta && PLAN_LIMITS[fromMeta]) {
        return fromMeta;
      }
      return undefined;
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
            billingChurnLocked: false,
            stripeStarterTrialEligible: false,
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
          billingChurnLocked: false,
          stripeStarterTrialEligible: false,
          updatedAt: new Date(),
        },
        { merge: true },
      );
  }

  private planFromPriceId(priceId: string): PlanType | undefined {
    const p = priceId.trim();
    const ids: Array<{ id: string | undefined; plan: PlanType }> = [
      { id: process.env.STRIPE_PRICE_STARTER, plan: 'starter' },
      { id: process.env.STRIPE_PRICE_GROWTH, plan: 'growth' },
      { id: process.env.STRIPE_PRICE_SCALE, plan: 'scale' },
      { id: process.env.STRIPE_PRICE_STARTER_ANNUAL, plan: 'starter' },
      { id: process.env.STRIPE_PRICE_GROWTH_ANNUAL, plan: 'growth' },
      { id: process.env.STRIPE_PRICE_SCALE_ANNUAL, plan: 'scale' },
    ];
    for (const row of ids) {
      if (row.id?.trim() === p) return row.plan;
    }
    return undefined;
  }
}
