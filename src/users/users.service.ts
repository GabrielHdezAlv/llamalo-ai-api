import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  getMetricsCalendarTimezone,
  isValidIanaTimezone,
} from '../metrics/metrics-calendar.util';
import { PLAN_LIMITS, PlanType } from '../common/constants/plans.constants';
import { computeMinuteQuotaFromUserData } from '../common/utils/minute-quota.util';
import { getFirestore } from '../firebase/firebase.config';
import { MailerLiteService } from '../mailerlite/mailerlite.service';
import { ProfileEventsService } from '../profile-events/profile-events.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
import type { PlanUsageSnapshot } from '../plan-limits/plan-limits.service';

interface PhoneNumber {
  phoneId: number;
  countryCode: string;
  number: string;
  state: 'Activo' | 'Inactivo';
  importedBy: string;
  twilioAccountId: number;
}

interface Agent {
  name: string;
  type: 'outbound' | 'inbound';
  language: string;
  voiceId: string;
  firstInteraction: string;
  agentInstruction: string;
  phoneNumbers: PhoneNumber;
  twilioAccountId?: number;
  label: string;
  state: 'Activo' | 'Inactivo';
  parameters: {
    stability: number;
    similarity: number;
    style: number;
    boost: boolean;
    speed: number;
  };
  totalMinutes: number;
}

interface UserData {
  userId?: string;
  profileImage?: string;
  name?: string;
  lastname?: string;
  enterprise?: {
    name: string;
    url: string;
  };
  email?: string;
  password?: string;
  country?: string;
  marketingConsent?: boolean;
  accountStatus?: number;
  rol?: 'owner' | 'client_user';
  hasCompletedSetup?: boolean;
  createdAt?: admin.firestore.Timestamp | string;
  scheduledDeletionDate?: admin.firestore.Timestamp;
  plan?: string;
  integrations?: {
    shopify?: Array<{
      connected: boolean;
      shopDomain: string;
    }>;
  };
  twilio?: Array<{
    twilioAccountId: number;
    twilioSid: string;
    twilioToken: string;
  }>;
  phoneNumbers?: PhoneNumber[];
  agents?: Agent[];
  minutesLimit?: number;
  extraMinutes?: number;
  minutesByMonth?: Record<string, number>;
  redeemedRewards?: string[];
  trialEndsAt?: admin.firestore.Timestamp;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  /** Suscripción cancelada: debe re-suscribirse (pantalla dedicada, sin trial Starter). */
  billingChurnLocked?: boolean;
  /** false = no ofrecer 7 días Starter (ya pagó o churn). Ausente/true = elegible trial. */
  stripeStarterTrialEligible?: boolean;
  planSelectionCompleted?: boolean;
  /** Respuestas registro onboarding (pasos 1–2) */
  onboardingRegistration?: {
    goals?: string[];
    discoveryChannels?: string[];
    updatedAt?: admin.firestore.Timestamp;
  };
  /** IANA: semanas/meses de negocio en métricas del panel */
  metricsCalendarTimezone?: string;
}

export type UserProfileResponse = {
  userId: string;
  name?: string;
  lastname?: string;
  profileImage?: string;
  enterprise?: {
    name: string;
    url: string;
  };
  email?: string;
  country?: string;
  marketingConsent?: boolean;
  accountStatus?: number;
  rol?: 'owner' | 'client_user';
  hasCompletedSetup?: boolean;
  createdAt?: string | null;
  twilio?: Array<{
    twilioAccountId: number;
    twilioSid: string;
    twilioToken: string;
  }>;
  agent?: Record<string, unknown>;
  integrations?: {
    shopify?: Array<{
      connected: boolean;
      shopDomain: string;
    }>;
  };
  phoneNumbers?: Array<{
    phoneId: number;
    countryCode: string;
    number: string;
    state: 'Activo' | 'Inactivo';
    importedBy: string;
    twilioAccountId: number;
  }>;
  agents?: Array<{
    name: string;
    type: 'outbound' | 'inbound';
    language: string;
    voiceId: string;
    firstInteraction: string;
    agentInstruction: string;
    phoneNumbers: {
      phoneId: number;
      countryCode: string;
      number: string;
    };
    twilioAccountId?: number;
    label: string;
    state: 'Activo' | 'Inactivo';
    parameters: {
      stability: number;
      similarity: number;
      style: number;
      boost: boolean;
      speed: number;
    };
    totalMinutes: number;
  }>;
  plan?: string;
  minutesLimit?: number;
  extraMinutes?: number;
  minutesByMonth?: Record<string, number>;
  redeemedRewards?: string[];
  trialEndsAt?: string | null;
  planUsage?: PlanUsageSnapshot;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  billingChurnLocked?: boolean;
  stripeStarterTrialEligible?: boolean;
  /** false = pendiente elegir plan o prueba tras registro; ausente/true = ya elegido (legacy = completado) */
  planSelectionCompleted?: boolean;
  /** Resuelta: perfil o `METRICS_CALENDAR_TIMEZONE` / Europe/Madrid */
  metricsCalendarTimezone?: string;
};

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class UsersService {
  private firestore = getFirestore();
  private storage = admin.storage();

  constructor(
    private readonly mailerLiteService: MailerLiteService,
    private readonly profileEventsService: ProfileEventsService,
    private readonly planLimitsService: PlanLimitsService,
  ) {}

  /** Zona mostrada en API: Firestore válida o fallback del servidor (Europe/Madrid). */
  private resolveDisplayMetricsTimezone(userData: UserData): string {
    const raw = userData.metricsCalendarTimezone;
    if (
      typeof raw === 'string' &&
      raw.trim() &&
      isValidIanaTimezone(raw.trim())
    ) {
      return raw.trim();
    }
    return getMetricsCalendarTimezone();
  }

  private filterPhoneNumbers(phoneNumbers: PhoneNumber[], query?: string) {
    if (!query || !query.trim()) {
      return phoneNumbers;
    }

    const q = query.toLowerCase().trim();

    return phoneNumbers.filter((phone) => {
      const countryCode = phone.countryCode?.toLowerCase() || '';
      const number = phone.number?.toLowerCase() || '';
      const importedBy = phone.importedBy?.toLowerCase() || '';
      const state = phone.state?.toLowerCase() || '';

      return (
        countryCode.includes(q) ||
        number.includes(q) ||
        importedBy.includes(q) ||
        state.includes(q)
      );
    });
  }

  // Helper para calcular el estado de un phoneNumber basado en si algún agente lo usa
  private calculatePhoneNumberState(
    phoneId: number,
    agents: Agent[] | undefined,
  ): 'Activo' | 'Inactivo' {
    if (!agents || agents.length === 0) {
      return 'Inactivo';
    }
    const isUsed = agents.some(
      (agent) => agent.phoneNumbers?.phoneId === phoneId,
    );
    return isUsed ? 'Activo' : 'Inactivo';
  }

  // ✅ Obtener perfil del usuario
  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const userData = snapshot.data() as UserData;
      const planUsage = await this.planLimitsService.getPlanUsageSnapshot(userId);

      let trialEndsAtStr: string | null = null;
      const te = userData.trialEndsAt;
      if (te && typeof (te as admin.firestore.Timestamp).toDate === 'function') {
        trialEndsAtStr = (te as admin.firestore.Timestamp).toDate().toISOString();
      } else if (planUsage?.trialEndsAt) {
        trialEndsAtStr = planUsage.trialEndsAt;
      }

      // ✅ Convertir createdAt a string legible
      let createdAtStr: string | null = null;
      const rawData = snapshot.data() as Record<string, unknown>;
      if (rawData?.createdAt) {
        const tsObj = rawData.createdAt as admin.firestore.Timestamp;
        if (tsObj && typeof tsObj.toDate === 'function') {
          const date = tsObj.toDate();
          createdAtStr =
            date.toLocaleDateString('es-ES', {
              day: '2-digit',
              month: 'long',
              year: 'numeric',
            }) +
            ', ' +
            date.toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            });
        }
      }

      return {
        userId,
        name: userData?.name,
        lastname: userData?.lastname,
        profileImage: userData?.profileImage,
        enterprise: userData?.enterprise || { name: '', url: '' },
        email: userData?.email,
        country: userData?.country,
        marketingConsent: userData?.marketingConsent,
        accountStatus: userData?.accountStatus,
        rol: userData?.rol || 'client_user',
        hasCompletedSetup: userData?.hasCompletedSetup ?? true,
        createdAt: createdAtStr,
        twilio: userData?.twilio,
        agent: (userData?.agents?.[0] || {}) as Record<string, unknown>, // Compatibilidad: devolver primer agente como agent
        // Nuevos campos
        integrations: userData?.integrations,
        phoneNumbers: (userData?.phoneNumbers || []).map((phone) => ({
          ...phone,
          state: this.calculatePhoneNumberState(
            phone.phoneId,
            userData?.agents,
          ),
          importedBy: phone.importedBy || 'Twilio',
        })),
        agents: userData?.agents || [],
        plan: userData?.plan ?? 'gratis',
        minutesLimit: this.planLimitsService.getEffectiveVoiceMinutesLimit(
          userData as unknown as admin.firestore.DocumentData,
        ),
        extraMinutes: userData?.extraMinutes ?? 0, // Minutos extra por defecto
        minutesByMonth: userData?.minutesByMonth ?? {}, // Historial de minutos por mes
        redeemedRewards: userData?.redeemedRewards ?? [],
        trialEndsAt: trialEndsAtStr,
        planUsage: planUsage ?? undefined,
        stripeCustomerId: userData?.stripeCustomerId ?? null,
        stripeSubscriptionId: userData?.stripeSubscriptionId ?? null,
        stripeSubscriptionStatus: userData?.stripeSubscriptionStatus ?? null,
        billingChurnLocked: userData?.billingChurnLocked === true,
        stripeStarterTrialEligible: userData?.stripeStarterTrialEligible !== false,
        planSelectionCompleted: userData?.planSelectionCompleted !== false,
        metricsCalendarTimezone: this.resolveDisplayMetricsTimezone(userData),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener el perfil del usuario: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Obtener phoneNumbers del usuario (con búsqueda opcional)
  async getUserPhoneNumbers(userId: string, query?: string) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const userData = snapshot.data() as UserData;

      const rawPhoneNumbers = userData?.phoneNumbers || [];
      const enrichedPhoneNumbers = rawPhoneNumbers.map((phone) => ({
        ...phone,
        state: this.calculatePhoneNumberState(phone.phoneId, userData?.agents),
        importedBy: phone.importedBy || 'Twilio',
      }));

      const filteredPhoneNumbers = this.filterPhoneNumbers(
        enrichedPhoneNumbers,
        query,
      );

      return {
        phoneNumbers: filteredPhoneNumbers,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener los números de teléfono: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Actualizar perfil del usuario
  async updateUserProfile(userId: string, updateDto: UpdateProfileDto) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      // � Validar que profileImage no sea una blob URL
      if (
        updateDto.profileImage &&
        updateDto.profileImage.startsWith('blob:')
      ) {
        throw new BadRequestException(
          'Las blob URLs no son válidas. Por favor, suba el archivo de imagen directamente.',
        );
      }

      // �📦 Solo actualizar los campos que se reciban
      const updates: Record<string, unknown> = {};

      if (updateDto.name) updates.name = updateDto.name;
      if (updateDto.lastname) updates.lastname = updateDto.lastname;
      if (updateDto.profileImage) updates.profileImage = updateDto.profileImage;

      // Actualizar enterprise como objeto
      if (updateDto.enterprise) {
        updates.enterprise = updateDto.enterprise;
      }

      if (updateDto.country) updates.country = updateDto.country;
      if (updateDto.marketingConsent !== undefined)
        updates.marketingConsent = updateDto.marketingConsent;
      if (updateDto.accountStatus !== undefined)
        updates.accountStatus = updateDto.accountStatus;
      if (updateDto.rol !== undefined) updates.rol = updateDto.rol;
      
      // ✅ Si pasamos 'true' o 'false' textualmente desde FormData (FormData pasa strings)
      if (updateDto.hasCompletedSetup !== undefined) {
        updates.hasCompletedSetup = 
          updateDto.hasCompletedSetup === 'true' || 
          updateDto.hasCompletedSetup === true;
      }
      
      if (updateDto.minutesLimit !== undefined) {
        updates.minutesLimit = Number(updateDto.minutesLimit);
      }

      if (updateDto.extraMinutes !== undefined) {
        updates.extraMinutes = Number(updateDto.extraMinutes);
      }

      if (
        updateDto.onboardingGoals !== undefined ||
        updateDto.onboardingDiscoveryChannels !== undefined
      ) {
        const prev = (snapshot.data() as UserData)?.onboardingRegistration;
        const prevGoals = Array.isArray(prev?.goals) ? prev.goals : [];
        const prevDiscovery = Array.isArray(prev?.discoveryChannels)
          ? prev.discoveryChannels
          : [];
        updates.onboardingRegistration = {
          goals:
            updateDto.onboardingGoals !== undefined
              ? updateDto.onboardingGoals
              : prevGoals,
          discoveryChannels:
            updateDto.onboardingDiscoveryChannels !== undefined
              ? updateDto.onboardingDiscoveryChannels
              : prevDiscovery,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      }

      if (updateDto.metricsCalendarTimezone !== undefined) {
        const s = String(updateDto.metricsCalendarTimezone).trim();
        if (s && !isValidIanaTimezone(s)) {
          throw new BadRequestException(
            'Zona horaria de métricas no válida (use un identificador IANA, p. ej. Europe/Madrid).',
          );
        }
        if (s) {
          updates.metricsCalendarTimezone = s;
        } else {
          updates.metricsCalendarTimezone = admin.firestore.FieldValue.delete();
        }
      }

      if (Object.keys(updates).length === 0) {
        throw new BadRequestException('No se enviaron datos para actualizar');
      }

      // ✏️ Actualizar Firestore
      await docRef.update(updates);

      if (
        updates.minutesLimit !== undefined ||
        updates.extraMinutes !== undefined
      ) {
        this.profileEventsService.notifyProfileUpdated(userId);
      }

      // 🔄 Sincronizar con MailerLite si se actualizaron campos relevantes
      if (
        updates.hasCompletedSetup !== undefined ||
        updates.minutesLimit !== undefined ||
        updates.accountStatus !== undefined ||
        updates.rol !== undefined
      ) {
        this.mailerLiteService.syncUser(userId).catch(() => {});
      }

      // 🔄 Obtener de nuevo el perfil actualizado
      const updatedSnapshot = await docRef.get();
      const updatedData = updatedSnapshot.data() as UserData;

      return {
        message: 'Perfil actualizado correctamente',
        name: updatedData?.name,
        lastname: updatedData?.lastname,
        profileImage: updatedData?.profileImage,
        enterprise: updatedData?.enterprise || { name: '', url: '' },
        email: updatedData?.email,
        country: updatedData?.country,
        marketingConsent: updatedData?.marketingConsent,
        accountStatus: updatedData?.accountStatus,
        rol: updatedData?.rol || 'client_user',
        hasCompletedSetup: updatedData?.hasCompletedSetup ?? true,
        minutesLimit: updatedData?.minutesLimit ?? 100,
        extraMinutes: updatedData?.extraMinutes ?? 0,
        minutesByMonth: updatedData?.minutesByMonth ?? {},
        redeemedRewards: updatedData?.redeemedRewards ?? [],
        createdAt: updatedData?.createdAt,
        metricsCalendarTimezone:
          this.resolveDisplayMetricsTimezone(updatedData),
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al actualizar el perfil del usuario: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Subir imagen de perfil
  async uploadProfileImage(userId: string, file: UploadFile) {
    try {
      // Validaciones
      if (!file) {
        throw new BadRequestException('Debe enviarse un archivo de imagen');
      }

      if (file.size > 5 * 1024 * 1024) {
        throw new BadRequestException('La imagen no puede superar los 5MB');
      }

      const allowedTypes = [
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/webp',
      ];
      if (!allowedTypes.includes(file.mimetype)) {
        throw new BadRequestException(
          'Formato de imagen no permitido. Use PNG, JPG o WebP',
        );
      }

      const bucket = this.storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const extension = file.originalname.split('.').pop();
      const uniqueId = uuidv4();
      const fileName = `profile-images/${uniqueId}.${extension}`;
      const fileRef = bucket.file(fileName);

      // Subir nueva imagen con ACL pública
      await fileRef.save(file.buffer, {
        metadata: {
          contentType: file.mimetype,
        },
        public: true,
        predefinedAcl: 'publicRead',
      });

      // Hacer público el archivo como salvaguarda
      await fileRef.makePublic();

      const imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;

      // Actualizar URL en Firestore
      const userDocRef = this.firestore.collection('users').doc(userId);
      await userDocRef.update({ profileImage: imageUrl });

      return {
        message: 'Imagen de perfil actualizada correctamente',
        imageUrl,
      };
    } catch (error) {
      console.error('Error uploading image:', error);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al subir la imagen: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Programar eliminación de cuenta (10 días después)
  async scheduleAccountDeletion(userId: string) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      // Calcular fecha de eliminación (10 días desde ahora)
      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 10);
      const scheduledDeletionTimestamp =
        admin.firestore.Timestamp.fromDate(deletionDate);

      // Guardar la fecha de eliminación programada
      await docRef.update({
        scheduledDeletionDate: scheduledDeletionTimestamp,
      });

      return {
        message: 'Cuenta programada para eliminación en 10 días',
        scheduledDeletionDate: deletionDate.toISOString(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al programar la eliminación de la cuenta: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Procesar eliminaciones programadas (marcar como "Eliminado" después de 10 días)
  async processScheduledDeletions() {
    try {
      const now = admin.firestore.Timestamp.now();

      // Buscar usuarios con scheduledDeletionDate <= ahora
      const usersRef = this.firestore.collection('users');
      const snapshot = await usersRef
        .where('scheduledDeletionDate', '<=', now)
        .get();

      let deletedCount = 0;
      const batches: admin.firestore.WriteBatch[] = [];
      let currentBatch = this.firestore.batch();
      let currentBatchSize = 0;
      const batchSize = 500; // Firestore limita a 500 operaciones por batch

      snapshot.forEach((doc) => {
        const userData = doc.data() as UserData;

        // Solo procesar si accountStatus no es "Eliminado" (2)
        if (userData.accountStatus !== 2) {
          currentBatch.update(doc.ref, {
            accountStatus: 2, // 2 = "Eliminado"
          });
          deletedCount++;
          currentBatchSize++;

          // Si llegamos al límite del batch, guardarlo y crear uno nuevo
          if (currentBatchSize >= batchSize) {
            batches.push(currentBatch);
            currentBatch = this.firestore.batch();
            currentBatchSize = 0;
          }
        }
      });

      // Agregar el batch final si tiene operaciones
      if (currentBatchSize > 0) {
        batches.push(currentBatch);
      }

      // Ejecutar todos los batches
      for (const batch of batches) {
        await batch.commit();
      }

      if (deletedCount > 0) {
        console.log(
          `✅ [Users] ${deletedCount} cuenta(s) marcada(s) como eliminada(s)`,
        );
      }

      return {
        message: `Procesadas ${deletedCount} eliminaciones`,
        deletedCount,
      };
    } catch (error) {
      console.error(
        '❌ [Users] Error al procesar eliminaciones programadas:',
        error,
      );
      throw new BadRequestException(
        `Error al procesar eliminaciones programadas: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Canjear recompensa
  async redeemReward(userId: string, rewardType: string) {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const userData = snapshot.data() as UserData;
      const redeemedRewards = userData.redeemedRewards || [];

      // Validar si la recompensa ya fue canjeada
      if (redeemedRewards.includes(rewardType)) {
        throw new BadRequestException('Esta recompensa ya ha sido canjeada.');
      }

      // Definir los minutos a añadir según el tipo de recompensa
      // Usamos un mapa estándar basado en la descripción de la UI
      let minutesToAdd = 1;
      switch (rewardType) {
        case 'Trustpilot':
          minutesToAdd = 10;
          break;
        case 'instagram':
        case 'linkedin':
        case 'x':
          minutesToAdd = 1;
          break;
        case 'Gift3': // Mención en tienda o red social
          minutesToAdd = 20;
          break;
        default:
          minutesToAdd = 1; // Por defecto 1 minuto según las instrucciones
          break;
      }

      const currentExtraMinutes = userData.extraMinutes || 0;
      const newExtraMinutes = currentExtraMinutes + minutesToAdd;
      
      const newRedeemedRewards = [...redeemedRewards, rewardType];

      // Actualizar Firestore
      await docRef.update({
        extraMinutes: newExtraMinutes,
        redeemedRewards: newRedeemedRewards,
      });

      this.profileEventsService.notifyProfileUpdated(userId);

      return {
        message: `Recompensa canjeada con éxito. Se han añadido ${minutesToAdd} minutos extra.`,
        extraMinutes: newExtraMinutes,
        redeemedRewards: newRedeemedRewards,
      };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al canjear recompensa: ${(error as Error).message}`,
      );
    }
  }

  /**
   * En producción el cambio de plan manual está desactivado salvo
   * ALLOW_PLAN_CHANGE_MOCK=true (pruebas). El flujo real irá vía Stripe/webhooks.
   */
  private assertPlanChangeMockAllowed(): void {
    const isProd = process.env.NODE_ENV === 'production';
    const allowMock = process.env.ALLOW_PLAN_CHANGE_MOCK === 'true';
    if (isProd && !allowMock) {
      throw new ForbiddenException(
        'El cambio de plan manual no está disponible en este entorno. Usa el proceso de suscripción cuando esté activo.',
      );
    }
  }

  // ✅ Cambiar plan del usuario (Upgrade/Downgrade) — mock / desarrollo
  async changePlan(userId: string, newPlan: PlanType) {
    this.assertPlanChangeMockAllowed();
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const planLimit = PLAN_LIMITS[newPlan];
      if (!planLimit) {
        throw new BadRequestException('Plan inválido');
      }

      // Actualizar el plan y el límite de minutos base
      await docRef.update({
        plan: newPlan,
        minutesLimit: planLimit.minutesLimit,
      });

      this.profileEventsService.notifyProfileUpdated(userId);

      return {
        message: 'Plan actualizado correctamente',
        plan: newPlan,
        minutesLimit: planLimit.minutesLimit,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al actualizar el plan: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Comprobar si el usuario tiene minutos disponibles
  async hasAvailableMinutes(userId: string): Promise<{
    hasMinutes: boolean;
    availableMinutes: number;
    usedMinutes: number;
    totalLimit: number;
  }> {
    try {
      const docRef = this.firestore.collection('users').doc(userId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Usuario no encontrado en Firestore');
      }

      const userData = snapshot.data() as UserData;
      const effectiveMinutes =
        this.planLimitsService.getEffectiveVoiceMinutesLimit(userData);
      return computeMinuteQuotaFromUserData(userData, {
        effectiveMinutesLimit: effectiveMinutes,
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException(
        `Error al comprobar minutos: ${(error as Error).message}`
      );
    }
  }
}
