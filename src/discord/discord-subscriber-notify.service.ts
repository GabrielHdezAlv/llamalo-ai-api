import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';

const LOCK_COLLECTION = 'discordCheckoutNotifyLocks';

export type CheckoutDiscordNotifyParams = {
  sessionId: string;
  userId: string;
  planLabel: string;
  starterTrialing: boolean;
};

@Injectable()
export class DiscordSubscriberNotifyService {
  private readonly logger = new Logger(DiscordSubscriberNotifyService.name);
  private readonly firestore = getFirestore();

  /**
   * Tras checkout completado: aviso al canal interno (solo si está configurada la URL del webhook).
   * Idempotente por `sessionId` (Stripe puede reintentar el mismo evento).
   */
  async notifyCheckoutSessionCompleted(
    params: CheckoutDiscordNotifyParams,
  ): Promise<void> {
    const url = process.env.DISCORD_NEW_SUBSCRIBER_WEBHOOK_URL?.trim();
    if (!url) {
      return;
    }

    const lockId = `checkout_${params.sessionId}`;
    const lockRef = this.firestore.collection(LOCK_COLLECTION).doc(lockId);
    try {
      await lockRef.create({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        userId: params.userId,
      });
    } catch (e) {
      if (this.isAlreadyExists(e)) {
        this.logger.log(
          `Discord notify ya enviado o en curso para sesión ${params.sessionId}; omitiendo`,
        );
        return;
      }
      this.logger.warn(
        `No se pudo crear lock Discord notify ${lockId}: ${(e as Error).message}`,
      );
      return;
    }

    let userEmail: string | null = null;
    try {
      const u = await this.firestore.collection('users').doc(params.userId).get();
      const em = (u.data() as { email?: string } | undefined)?.email?.trim();
      if (em) {
        userEmail = em;
      }
    } catch {
      /* ignore */
    }

    const statusLabel = params.starterTrialing
      ? 'Prueba 7 días (Stripe)'
      : 'Suscripción activa';

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      {
        name: 'Correo',
        value: userEmail ?? '— (no en perfil)',
        inline: false,
      },
      {
        name: 'Plan contratado',
        value: params.planLabel,
        inline: true,
      },
      { name: 'Estado', value: statusLabel, inline: true },
      {
        name: 'Usuario (ID)',
        value: `\`${params.userId}\``,
        inline: false,
      },
    ];

    const body = {
      username: 'Llamalo',
      embeds: [
        {
          title: '🎉 Nuevo suscriptor',
          description:
            'Alguien ha completado el checkout de un plan de pago en producción.',
          color: 0x5865f2,
          fields,
          footer: { text: 'Stripe · checkout.session.completed' },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      const res = await axios.post(url, body, {
        timeout: 12_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }
      await lockRef.set(
        { notifiedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      this.logger.log(`Discord: aviso de nuevo suscriptor enviado (${params.sessionId})`);
    } catch (e) {
      try {
        await lockRef.delete();
      } catch {
        /* ignore */
      }
      this.logger.warn(
        `Discord: no se pudo enviar aviso de suscriptor: ${(e as Error).message}`,
      );
    }
  }

  private isAlreadyExists(err: unknown): boolean {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code: number | string }).code
        : undefined;
    return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
  }
}
