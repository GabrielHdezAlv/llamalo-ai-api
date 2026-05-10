import { Injectable } from '@nestjs/common';
import { getFirestore } from '../firebase/firebase.config';
import {
  computeEnqueueNotBeforeIso,
  parseOutboundSegmentationNotes,
  phoneMatchesCountrySegmentation,
} from '../calls/outbound-scheduling.util';
import { evaluateOutboundSegmentationForContact } from '../calls/outbound-segmentation-eval.util';

export type OutboundQueueSource = 'csv' | 'make' | 'shopify' | 'manual';

/** Input alineado con columnas CSV / Make / Shopify. */
export interface OutboundQueueLeadInput {
  phone: string;
  eventAt?: string | null;
  externalEventId?: string | null;
  contactTicket?: number | null;
  customerState?: 'new' | 'recurring' | string | null;
  cartTotal?: number | null;
  cartItemCount?: number | null;
  productHandle?: string | null;
}

@Injectable()
export class OutboundQueueService {
  private firestore = getFirestore();

  toE164(raw: string): string {
    const normalizedPhone = raw.replace(/\s|-|\(|\)/g, '');
    if (!normalizedPhone) return '';
    return normalizedPhone.startsWith('+')
      ? normalizedPhone
      : `+${normalizedPhone.replace(/\D/g, '')}`;
  }

  queueDocId(
    agentId: number,
    e164: string,
    externalEventId?: string | null,
  ): string {
    const digits = e164.replace(/\D/g, '');
    const base = `${agentId}_${digits}`;
    if (externalEventId && String(externalEventId).trim()) {
      const ext = String(externalEventId)
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 100);
      return `${base}_${ext}`;
    }
    return base;
  }

  private metaFields(row: OutboundQueueLeadInput): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (row.contactTicket !== undefined && row.contactTicket !== null) {
      o.contactTicket = row.contactTicket;
    }
    if (row.customerState !== undefined && row.customerState !== null) {
      o.customerState = row.customerState;
    }
    if (row.cartTotal !== undefined && row.cartTotal !== null) {
      o.cartTotal = row.cartTotal;
    }
    if (row.cartItemCount !== undefined && row.cartItemCount !== null) {
      o.cartItemCount = row.cartItemCount;
    }
    if (row.productHandle !== undefined && row.productHandle !== null) {
      o.productHandle = row.productHandle;
    }
    return o;
  }

  /**
   * Crea ítems en `outbound_queue` que aún no existen (por id de documento).
   * Si llegan filas enriquecidas, `eventAt` alimenta `computeEnqueueNotBeforeIso`.
   */
  async syncQueue(
    userId: string,
    agentId: number,
    phones: string[],
    leads: OutboundQueueLeadInput[] | undefined,
    agentScheduling: {
      outboundCampaignKind?: string;
      outboundScheduleCampaignNotes?: string;
      outboundSegmentationNotes?: string;
    },
    source: OutboundQueueSource = 'csv',
  ): Promise<void> {
    const campaignKind = agentScheduling.outboundCampaignKind || '';
    const segmentation = parseOutboundSegmentationNotes(
      agentScheduling.outboundSegmentationNotes,
    );
    const queueRef = this.firestore.collection('outbound_queue');

    const existingSnapshot = await queueRef.where('agentId', '==', agentId).get();
    const existingDocIds = new Set<string>();
    existingSnapshot.docs.forEach((doc) => existingDocIds.add(doc.id));

    const rows: OutboundQueueLeadInput[] =
      leads && leads.length > 0
        ? leads
        : phones.map((p) => ({ phone: p }));

    const now = new Date().toISOString();
    const batch = this.firestore.batch();
    let count = 0;

    for (const row of rows) {
      const e164Phone = this.toE164(row.phone);
      if (!e164Phone) continue;

      const docId = this.queueDocId(agentId, e164Phone, row.externalEventId);
      if (existingDocIds.has(docId)) continue;

      const baseMeta = this.metaFields(row);
      const contactMeta = {
        contactTicket: row.contactTicket,
        customerState: row.customerState,
        cartTotal: row.cartTotal,
        cartItemCount: row.cartItemCount,
        productHandle: row.productHandle,
      };

      if (!phoneMatchesCountrySegmentation(e164Phone, segmentation)) {
        batch.set(queueRef.doc(docId), {
          userId,
          agentId,
          phoneNumber: e164Phone,
          status: 'failed',
          campaignKind,
          errorMessage:
            'Segmentación: el número no coincide con el país configurado para la campaña.',
          notBefore: now,
          failureCount: 0,
          callsTodayDate: '',
          dialsTodayCount: 0,
          createdAt: now,
          updatedAt: now,
          source,
          ...(row.eventAt && { eventAt: row.eventAt }),
          ...(row.externalEventId != null &&
            String(row.externalEventId).trim() !== '' && {
              externalEventId: String(row.externalEventId).trim(),
            }),
          ...baseMeta,
        });
        existingDocIds.add(docId);
        count++;
        continue;
      }

      const segEval = evaluateOutboundSegmentationForContact(
        campaignKind,
        agentScheduling.outboundSegmentationNotes,
        contactMeta,
      );
      if (!segEval.ok) {
        batch.set(queueRef.doc(docId), {
          userId,
          agentId,
          phoneNumber: e164Phone,
          status: 'failed',
          campaignKind,
          errorMessage: segEval.reason ?? 'Segmentación no cumplida.',
          notBefore: now,
          failureCount: 0,
          callsTodayDate: '',
          dialsTodayCount: 0,
          createdAt: now,
          updatedAt: now,
          source,
          ...(row.eventAt && { eventAt: row.eventAt }),
          ...(row.externalEventId != null &&
            String(row.externalEventId).trim() !== '' && {
              externalEventId: String(row.externalEventId).trim(),
            }),
          ...baseMeta,
        });
        existingDocIds.add(docId);
        count++;
        continue;
      }

      const notBeforeIso = computeEnqueueNotBeforeIso(
        campaignKind,
        agentScheduling.outboundScheduleCampaignNotes,
        agentScheduling.outboundSegmentationNotes,
        {
          referenceUtc: new Date(),
          eventAtIso: row.eventAt,
        },
      );

      batch.set(queueRef.doc(docId), {
        userId,
        agentId,
        phoneNumber: e164Phone,
        status: 'pending',
        campaignKind,
        notBefore: notBeforeIso,
        failureCount: 0,
        callsTodayDate: '',
        dialsTodayCount: 0,
        createdAt: now,
        updatedAt: now,
        source,
        ...(row.eventAt && { eventAt: row.eventAt }),
        ...(row.externalEventId != null &&
          String(row.externalEventId).trim() !== '' && {
            externalEventId: String(row.externalEventId).trim(),
          }),
        ...baseMeta,
      });
      existingDocIds.add(docId);
      count++;
    }

    if (count > 0) {
      await batch.commit();
      console.log(
        `[Outbound] Añadidos ${count} elementos en la cola para el agente ${agentId}`,
      );
    }
  }
}
