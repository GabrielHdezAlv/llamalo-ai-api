import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { getFirestore } from '../firebase/firebase.config';
import * as admin from 'firebase-admin';
import {
  DEFAULT_PLAN,
  LEGACY_FREE_PLAN_SLUGS,
} from '../common/constants/plans.constants';

@Injectable()
export class MailerLiteService {
  private readonly logger = new Logger(MailerLiteService.name);
  private readonly apiKey = process.env.MAILERLITE_API_KEY;
  private readonly baseUrl = 'https://connect.mailerlite.com/api';
  private readonly firestore = getFirestore();

  private readonly groups = {
    SIN_LLAMADAS: '178201409778353417',
    SETUP_NO_COMPLETADO: '178201688401773750',
    SETUP_COMPLETADO: '178201208129848516',
    PLAN_PAGO: '161200751988705064',
    NUEVO_USUARIO: '151309297489282526',
    DIA_14: '179129137749821143',
    DIA_13: '179129107491063431',
    DIA_11: '179129103001060489',
    CUENTA_NO_ACTIVADA: '160529624831362390',
    CUENTA_ACTIVADA: '160528752534619313',
    CON_LLAMADAS: '178201293482886453',
    MINUTOS_90: '179129073612620901',
    MINUTOS_80: '179128907731043692',
    MINUTOS_100: '179129085669148006',
  };

  /**
   * Sincroniza un usuario específico con MailerLite según las reglas de negocio.
   */
  async syncUser(userId: string) {
    if (!this.apiKey) {
      this.logger.warn('MAILERLITE_API_KEY no configurada. Saltando sincronización.');
      return;
    }

    try {
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (!userDoc.exists) return;

      const userData = userDoc.data();
      if (!userData) return;

      const email = userData.email;

      // Exclusiones: Rol owner o email específico
      if (userData.rol === 'owner' || email === 'development.team@llamalo.com') {
        this.logger.log(`Usuario excluido de sincronización MailerLite: ${email}`);
        // Opcionalmente: Eliminar de todos los grupos si ya existía
        return;
      }

      if (!email) return;

      const groupsToJoin: string[] = [];
      const now = new Date();
      const createdAtRaw = userData.createdAt;
      const createdAt = createdAtRaw instanceof admin.firestore.Timestamp
        ? createdAtRaw.toDate()
        : createdAtRaw
          ? new Date(createdAtRaw)
          : now;
      const diffDays = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      // 1. SIN/CON llamadas
      const currentMonthKey = this.getCurrentMonthKey();
      const totalMinutes = Object.values(userData.minutesByMonth || {}).reduce((a: number, b: number) => a + b, 0) as number;
      
      if (totalMinutes > 0) {
        groupsToJoin.push(this.groups.CON_LLAMADAS);
      } else {
        groupsToJoin.push(this.groups.SIN_LLAMADAS);
      }

      // 2. Setup Completado / NO Completado
      if (userData.hasCompletedSetup) {
        groupsToJoin.push(this.groups.SETUP_COMPLETADO);
      } else {
        groupsToJoin.push(this.groups.SETUP_NO_COMPLETADO);
      }

      // 3. Plan de Pago (gratis + slugs legacy = sin pago; starter/growth/scale = pago)
      const freePlans: string[] = [DEFAULT_PLAN, ...LEGACY_FREE_PLAN_SLUGS];
      const planSlug = userData.plan as string | undefined;
      const isPaid =
        userData.minutesLimit > 100 ||
        (planSlug != null && planSlug !== '' && !freePlans.includes(planSlug));
      if (isPaid) {
        groupsToJoin.push(this.groups.PLAN_PAGO);
      }

      // 4. Nuevo Usuario (últimos 7 días)
      if (diffDays <= 7) {
        groupsToJoin.push(this.groups.NUEVO_USUARIO);
      }

      // 5. Días específicos
      if (diffDays === 11) groupsToJoin.push(this.groups.DIA_11);
      if (diffDays === 13) groupsToJoin.push(this.groups.DIA_13);
      if (diffDays === 14) groupsToJoin.push(this.groups.DIA_14);

      // 6. Cuenta Activada / NO Activada
      if (userData.accountStatus === 1) {
        groupsToJoin.push(this.groups.CUENTA_ACTIVADA);
      } else if (userData.accountStatus === 3) {
        groupsToJoin.push(this.groups.CUENTA_NO_ACTIVADA);
      }

      // 7. Porcentaje de minutos usados
      const monthMinutes = (userData.minutesByMonth?.[currentMonthKey] || 0) as number;
      const limit = (userData.minutesLimit || 100) as number;
      const usagePercent = monthMinutes / limit;

      if (usagePercent >= 1.0) {
        groupsToJoin.push(this.groups.MINUTOS_100);
      } else if (usagePercent >= 0.9) {
        groupsToJoin.push(this.groups.MINUTOS_90);
      } else if (usagePercent >= 0.8) {
        groupsToJoin.push(this.groups.MINUTOS_80);
      }

      // Ejecutar la sincronización en MailerLite
      await this.updateMailerLiteSubscriber(email, userData.name, userData.lastname, groupsToJoin);

    } catch (error) {
      this.logger.error(`Error sincronizando usuario ${userId} con MailerLite: ${error.message}`);
    }
  }

  /**
   * Actualiza un suscriptor en MailerLite y gestiona sus grupos.
   * Usa PUT para suscriptores existentes (reemplaza grupos) y POST para nuevos.
   */
  private async updateMailerLiteSubscriber(email: string, name: string, lastname: string, groups: string[]) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    try {
      // 1. Intentar obtener suscriptor existente (por email)
      const getRes = await axios.get(`${this.baseUrl}/subscribers/${encodeURIComponent(email)}`, {
        headers,
        validateStatus: (s) => s === 200 || s === 404,
      });

      const fields = { name: name || '', last_name: lastname || '' };

      if (getRes.status === 200 && getRes.data?.data?.id) {
        // 2a. Suscriptor existe: PUT reemplaza los grupos (elimina de los no listados)
        await axios.put(
          `${this.baseUrl}/subscribers/${getRes.data.data.id}`,
          { fields, groups },
          { headers }
        );
      } else {
        // 2b. Suscriptor nuevo: POST crea con grupos
        await axios.post(
          `${this.baseUrl}/subscribers`,
          { email, fields, groups },
          { headers }
        );
      }

      this.logger.log(`Usuario ${email} sincronizado con grupos: ${groups.join(', ')}`);
    } catch (error) {
      const err = error as { response?: { data?: unknown }; message?: string };
      this.logger.error(`Error en API MailerLite para ${email}: ${JSON.stringify(err.response?.data || err.message)}`);
    }
  }

  private getCurrentMonthKey(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Sincroniza a todos los usuarios (útil para el cron job).
   */
  async syncAllUsers() {
    this.logger.log('Iniciando sincronización masiva con MailerLite...');
    const usersSnapshot = await this.firestore.collection('users').get();
    
    let count = 0;
    for (const doc of usersSnapshot.docs) {
      await this.syncUser(doc.id);
      count++;
      // Pequeño delay para evitar rate limiting de MailerLite
      if (count % 5 === 0) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    this.logger.log(`Sincronización masiva completada. ${count} usuarios procesados.`);
  }
}
