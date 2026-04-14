import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';
import {
  EXPIRED_TRIAL_TECH_LIMITS,
  PLAN_LIMITS,
  PlanLimitsEntry,
  PlanType,
  TRIAL_DURATION_DAYS,
  normalizePlanSlug,
} from '../common/constants/plans.constants';
import { KnowledgeSourceType } from '../knowledge-base/dto/knowledge-source.dto';

export type PlanUsageSnapshot = {
  trialEndsAt: string | null;
  trialActive: boolean;
  effectivePlanSlug: PlanType;
  limits: PlanLimitsEntry;
  agentsCount: number;
  webSourcesCount: number;
  docSourcesCount: number;
  /** PDF + TEXT */
  storageUsedBytes: number;
};

/** Suscripción Stripe con cobro pendiente o pausada: bloqueo total hasta regularizar pago. */
const STRIPE_BILLING_BLOCKED_STATUSES = new Set([
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
]);

@Injectable()
export class PlanLimitsService {
  private readonly firestore = getFirestore();

  /** True si Stripe indica que no hay acceso hasta pagar (p. ej. trial terminó sin tarjeta). */
  isStripeBillingBlocked(
    userData: admin.firestore.DocumentData | undefined,
  ): boolean {
    if (!userData) return false;
    const s = userData.stripeSubscriptionStatus as string | undefined;
    if (!s || typeof s !== 'string') return false;
    return STRIPE_BILLING_BLOCKED_STATUSES.has(s.trim());
  }

  /** Resuelve fin de trial en ms; si falta `trialEndsAt`, deriva de `createdAt` + 7 días. */
  resolveTrialEndsAtMs(userData: admin.firestore.DocumentData | undefined): number | null {
    if (!userData) return null;
    const raw = userData.trialEndsAt as admin.firestore.Timestamp | undefined;
    if (raw && typeof raw.toMillis === 'function') {
      return raw.toMillis();
    }
    const created = userData.createdAt as admin.firestore.Timestamp | undefined;
    if (created && typeof created.toMillis === 'function') {
      return created.toMillis() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
    }
    return null;
  }

  isTrialActive(userData: admin.firestore.DocumentData | undefined): boolean {
    const plan = normalizePlanSlug(userData?.plan as string | undefined);
    if (plan !== 'gratis') return false;
    const end = this.resolveTrialEndsAtMs(userData);
    if (end == null) return false;
    return Date.now() < end;
  }

  /**
   * Límites técnicos efectivos (agentes, KB, almacenamiento, etc.).
   * Cuenta `gratis`: mismos límites que Starter mientras el trial esté activo; si expiró, todo bloqueado salvo upgrade.
   */
  getEffectiveTechLimits(
    userData: admin.firestore.DocumentData | undefined,
  ): PlanLimitsEntry {
    if (this.isStripeBillingBlocked(userData)) {
      return { ...EXPIRED_TRIAL_TECH_LIMITS };
    }
    const plan = normalizePlanSlug(userData?.plan as string | undefined);
    if (plan !== 'gratis') {
      return { ...PLAN_LIMITS[plan] };
    }
    if (this.isTrialActive(userData)) {
      const s = PLAN_LIMITS.starter;
      return {
        ...s,
        name: 'Gratis (prueba)',
        price: 0,
        currency: 'EUR',
      };
    }
    return { ...EXPIRED_TRIAL_TECH_LIMITS };
  }

  /**
   * Minutos de voz efectivos para cupo (trial gratis = mismo techo que Starter).
   */
  getEffectiveVoiceMinutesLimit(
    userData: admin.firestore.DocumentData | undefined,
  ): number {
    if (this.isStripeBillingBlocked(userData)) {
      return 0;
    }
    const plan = normalizePlanSlug(userData?.plan as string | undefined);
    if (plan !== 'gratis') {
      const m = userData?.minutesLimit;
      if (typeof m === 'number' && !Number.isNaN(m)) return m;
      return PLAN_LIMITS[plan].minutesLimit;
    }
    if (this.isTrialActive(userData)) {
      return PLAN_LIMITS.starter.minutesLimit;
    }
    return 0;
  }

  async getUserData(userId: string): Promise<admin.firestore.DocumentData | undefined> {
    const snap = await this.firestore.collection('users').doc(userId).get();
    return snap.exists ? snap.data() : undefined;
  }

  async countKnowledgeByType(
    userId: string,
  ): Promise<{ web: number; pdf: number; text: number; storageBytes: number }> {
    const snap = await this.firestore
      .collection('knowledgeSources')
      .where('userId', '==', userId)
      .get();

    let web = 0;
    let pdf = 0;
    let text = 0;
    let storageBytes = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      const t = d.type as string;
      if (t === KnowledgeSourceType.WEB) web++;
      else if (t === KnowledgeSourceType.PDF) {
        pdf++;
        const b = d.sizeBytes;
        if (typeof b === 'number' && !Number.isNaN(b)) storageBytes += b;
      } else if (t === KnowledgeSourceType.TEXT) {
        text++;
        const b = d.sizeBytes;
        if (typeof b === 'number' && !Number.isNaN(b)) storageBytes += b;
      }
    }

    return { web, pdf, text, storageBytes };
  }

  async getPlanUsageSnapshot(userId: string): Promise<PlanUsageSnapshot | null> {
    const userData = await this.getUserData(userId);
    if (!userData) return null;
    const agents = (userData.agents as unknown[]) || [];
    const kb = await this.countKnowledgeByType(userId);
    const endMs = this.resolveTrialEndsAtMs(userData);
    return {
      trialEndsAt: endMs != null ? new Date(endMs).toISOString() : null,
      trialActive: this.isTrialActive(userData),
      effectivePlanSlug: normalizePlanSlug(userData.plan as string | undefined),
      limits: this.getEffectiveTechLimits(userData),
      agentsCount: agents.length,
      webSourcesCount: kb.web,
      docSourcesCount: kb.pdf + kb.text,
      storageUsedBytes: kb.storageBytes,
    };
  }

  /**
   * Comprueba trial expirado (gratis) y tope de agentes antes de persistir uno nuevo.
   * @param currentAgentCount agentes ya en array tras migración legacy, antes del push del nuevo.
   */
  /**
   * Valida trial, cupos de fuentes y tamaño antes de crear una fuente de conocimiento.
   */
  async assertCanCreateKnowledgeSource(
    userId: string,
    type: KnowledgeSourceType,
    options?: { fileSizeBytes?: number; textContentBytes?: number },
  ): Promise<void> {
    const userData = await this.getUserData(userId);
    if (!userData) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const plan = normalizePlanSlug(userData.plan as string | undefined);
    if (plan === 'gratis' && !this.isTrialActive(userData)) {
      throw new ForbiddenException(
        'Tu periodo de prueba ha terminado. Mejora tu plan para continuar.',
      );
    }
    const limits = this.getEffectiveTechLimits(userData);
    const counts = await this.countKnowledgeByType(userId);

    if (type === KnowledgeSourceType.WEB) {
      if (counts.web >= limits.indexedUrls) {
        throw new ForbiddenException(
          `Has alcanzado el máximo de URLs indexadas para tu plan (${limits.indexedUrls}).`,
        );
      }
      const estBytes = 512 * 1024;
      if (
        limits.storageTotalMb > 0 &&
        counts.storageBytes + estBytes > limits.storageTotalMb * 1024 * 1024
      ) {
        throw new ForbiddenException(
          'Has alcanzado el almacenamiento máximo de conocimiento de tu plan.',
        );
      }
      return;
    }

    const docCount = counts.pdf + counts.text;
    if (docCount >= limits.documentsMax) {
      throw new ForbiddenException(
        `Has alcanzado el máximo de documentos para tu plan (${limits.documentsMax}).`,
      );
    }

    let addBytes = 0;
    if (type === KnowledgeSourceType.PDF && options?.fileSizeBytes != null) {
      addBytes = options.fileSizeBytes;
      if (addBytes > limits.maxDocSizeMb * 1024 * 1024) {
        throw new ForbiddenException(
          `El archivo supera el tamaño máximo por documento de tu plan (${limits.maxDocSizeMb} MB).`,
        );
      }
    } else if (
      type === KnowledgeSourceType.TEXT &&
      options?.textContentBytes != null
    ) {
      addBytes = options.textContentBytes;
      if (addBytes > limits.maxDocSizeMb * 1024 * 1024) {
        throw new ForbiddenException(
          `El texto supera el tamaño máximo por documento de tu plan (${limits.maxDocSizeMb} MB).`,
        );
      }
    }

    if (
      limits.storageTotalMb > 0 &&
      counts.storageBytes + addBytes > limits.storageTotalMb * 1024 * 1024
    ) {
      throw new ForbiddenException(
        'Has alcanzado el almacenamiento máximo de conocimiento de tu plan.',
      );
    }
  }

  /** Shopify / WooCommerce según catálogo (Growth+ o trial con límites Starter sin Shopify). */
  async assertShopifyIntegrationAllowed(userId: string): Promise<void> {
    const userData = await this.getUserData(userId);
    if (!userData) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (normalizePlanSlug(userData.plan as string | undefined) === 'gratis' && !this.isTrialActive(userData)) {
      throw new ForbiddenException(
        'Tu periodo de prueba ha terminado. Mejora tu plan para continuar.',
      );
    }
    const limits = this.getEffectiveTechLimits(userData);
    if (!limits.integrations.includes('Shopify')) {
      throw new ForbiddenException(
        'La integración con Shopify está disponible desde el plan Growth.',
      );
    }
  }

  /** Funciones beta (p. ej. acceso anticipado) — solo Scale. */
  async assertBetaFeatureAllowed(userId: string): Promise<void> {
    const userData = await this.getUserData(userId);
    if (!userData) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const limits = this.getEffectiveTechLimits(userData);
    if (!limits.betaAccess) {
      throw new ForbiddenException(
        'Esta función está disponible en el plan Scale.',
      );
    }
  }

  async assertCanAddAgent(
    userId: string,
    currentAgentCount: number,
  ): Promise<void> {
    const userData = await this.getUserData(userId);
    if (!userData) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const plan = normalizePlanSlug(userData.plan as string | undefined);
    if (plan === 'gratis' && !this.isTrialActive(userData)) {
      throw new ForbiddenException(
        'Tu periodo de prueba ha terminado. Mejora tu plan para continuar.',
      );
    }
    const limits = this.getEffectiveTechLimits(userData);
    if (currentAgentCount >= limits.agents) {
      throw new ForbiddenException(
        `Has alcanzado el máximo de agentes para tu plan (${limits.agents}). Mejora el plan para añadir más.`,
      );
    }
  }
}
