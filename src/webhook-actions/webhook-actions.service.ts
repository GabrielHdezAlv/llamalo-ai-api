import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
import { CreateWebhookActionDto } from './dto/create-webhook-action.dto';
import { UpdateWebhookActionDto } from './dto/update-webhook-action.dto';
import { assertPublicHttpsWebhookUrl } from './utils/webhook-url.util';

export const MAKE_WEBHOOK_TOOL_PREFIX = 'make_webhook_';

export type WebhookActionRecord = {
  id: string;
  userId: string;
  agentId: number;
  name: string;
  description: string;
  webhookUrl: string;
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
};

/** Respuesta API (fechas ISO). */
export type WebhookActionPublicDto = {
  id: string;
  agentId: number;
  name: string;
  description: string;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
};

function toolNameFromDocId(docId: string): string {
  return `${MAKE_WEBHOOK_TOOL_PREFIX}${docId}`;
}

function toPublicDto(a: WebhookActionRecord): WebhookActionPublicDto {
  return {
    id: a.id,
    agentId: a.agentId,
    name: a.name,
    description: a.description,
    webhookUrl: a.webhookUrl,
    createdAt: a.createdAt.toDate().toISOString(),
    updatedAt: a.updatedAt.toDate().toISOString(),
  };
}

@Injectable()
export class WebhookActionsService {
  private readonly firestore = getFirestore();

  constructor(private readonly planLimitsService: PlanLimitsService) {}

  private allowHttpLocalhost(): boolean {
    return process.env.WEBHOOK_URL_ALLOW_HTTP_LOCALHOST === 'true';
  }

  private async assertUserOwnsAgent(
    userId: string,
    agentId: number,
  ): Promise<void> {
    const userData = await this.planLimitsService.getUserData(userId);
    if (!userData) {
      throw new NotFoundException('Usuario no encontrado.');
    }
    const agents =
      (userData.agents as Array<Record<string, unknown>> | undefined) || [];
    const ok = agents.some((a) => (a.agentId as number) === agentId);
    if (!ok) {
      throw new NotFoundException('Agente no encontrado.');
    }
  }

  async listForAgent(
    userId: string,
    agentId: number,
  ): Promise<WebhookActionPublicDto[]> {
    await this.assertUserOwnsAgent(userId, agentId);
    await this.planLimitsService.assertMakeWebhookFeatureAllowed(userId);

    const snap = await this.firestore
      .collection('webhookActions')
      .where('userId', '==', userId)
      .where('agentId', '==', agentId)
      .get();

    const rows: WebhookActionRecord[] = [];
    for (const doc of snap.docs) {
      const d = doc.data() as Omit<WebhookActionRecord, 'id'>;
      rows.push({ id: doc.id, ...d });
    }
    rows.sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis());
    return rows.map(toPublicDto);
  }

  /**
   * Acciones disponibles para el agente de voz (tras comprobar plan).
   * Usado por StreamsGateway al iniciar la llamada.
   */
  async listForCallSession(
    userId: string,
    agentId: number,
  ): Promise<WebhookActionRecord[]> {
    try {
      const userData = await this.planLimitsService.getUserData(userId);
      if (!userData) return [];
      const limits = this.planLimitsService.getEffectiveTechLimits(userData);
      if (limits.makeWebhookActionsMax <= 0) {
        return [];
      }
      await this.assertUserOwnsAgent(userId, agentId);
    } catch {
      return [];
    }

    const snap = await this.firestore
      .collection('webhookActions')
      .where('userId', '==', userId)
      .where('agentId', '==', agentId)
      .get();

    const rows: WebhookActionRecord[] = [];
    for (const doc of snap.docs) {
      const d = doc.data() as Omit<WebhookActionRecord, 'id'>;
      rows.push({ id: doc.id, ...d });
    }
    return rows;
  }

  async create(
    userId: string,
    agentId: number,
    dto: CreateWebhookActionDto,
  ): Promise<WebhookActionPublicDto> {
    await this.assertUserOwnsAgent(userId, agentId);
    await this.planLimitsService.assertMakeWebhookFeatureAllowed(userId);
    await this.planLimitsService.assertCanCreateWebhookAction(userId, agentId);

    assertPublicHttpsWebhookUrl(dto.webhookUrl, {
      allowHttpLocalhost: this.allowHttpLocalhost(),
    });

    const now = admin.firestore.Timestamp.now();
    const ref = this.firestore.collection('webhookActions').doc();
    const payload: Omit<WebhookActionRecord, 'id'> = {
      userId,
      agentId,
      name: dto.name.trim(),
      description: (dto.description ?? '').trim(),
      webhookUrl: dto.webhookUrl.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(payload);
    return toPublicDto({ id: ref.id, ...payload });
  }

  async update(
    userId: string,
    agentId: number,
    actionId: string,
    dto: UpdateWebhookActionDto,
  ): Promise<WebhookActionPublicDto> {
    await this.assertUserOwnsAgent(userId, agentId);
    await this.planLimitsService.assertMakeWebhookFeatureAllowed(userId);

    const ref = this.firestore.collection('webhookActions').doc(actionId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new NotFoundException('Acción no encontrada.');
    }
    const cur = snap.data() as Omit<WebhookActionRecord, 'id'>;
    if (cur.userId !== userId || cur.agentId !== agentId) {
      throw new NotFoundException('Acción no encontrada.');
    }

    const nextUrl = dto.webhookUrl?.trim() ?? cur.webhookUrl;
    if (dto.webhookUrl != null) {
      assertPublicHttpsWebhookUrl(nextUrl, {
        allowHttpLocalhost: this.allowHttpLocalhost(),
      });
    }

    const patch: Partial<Omit<WebhookActionRecord, 'id'>> = {
      updatedAt: admin.firestore.Timestamp.now(),
    };
    if (dto.name != null) patch.name = dto.name.trim();
    if (dto.description != null) patch.description = dto.description.trim();
    if (dto.webhookUrl != null) patch.webhookUrl = nextUrl;

    await ref.update(patch);
    const after = (await ref.get()).data() as Omit<WebhookActionRecord, 'id'>;
    return toPublicDto({ id: actionId, ...after });
  }

  async delete(
    userId: string,
    agentId: number,
    actionId: string,
  ): Promise<{ ok: true }> {
    await this.assertUserOwnsAgent(userId, agentId);

    const ref = this.firestore.collection('webhookActions').doc(actionId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new NotFoundException('Acción no encontrada.');
    }
    const cur = snap.data() as Omit<WebhookActionRecord, 'id'>;
    if (cur.userId !== userId || cur.agentId !== agentId) {
      throw new NotFoundException('Acción no encontrada.');
    }
    await ref.delete();
    return { ok: true };
  }

  /** Al borrar un agente, eliminar todas sus acciones webhook. */
  async deleteAllForAgent(userId: string, agentId: number): Promise<void> {
    const snap = await this.firestore
      .collection('webhookActions')
      .where('userId', '==', userId)
      .where('agentId', '==', agentId)
      .get();
    const batch = this.firestore.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    if (!snap.empty) {
      await batch.commit();
    }
  }

  getToolNameForDocId(docId: string): string {
    return toolNameFromDocId(docId);
  }

  findByToolNameInList(
    actions: WebhookActionRecord[],
    toolName: string,
  ): WebhookActionRecord | undefined {
    if (!toolName.startsWith(MAKE_WEBHOOK_TOOL_PREFIX)) {
      return undefined;
    }
    const id = toolName.slice(MAKE_WEBHOOK_TOOL_PREFIX.length);
    return actions.find((a) => a.id === id);
  }
}
