import { parseOutboundSegmentationNotes } from './outbound-scheduling.util';

type SegNumericCompareOp = '>' | '>=' | '<' | '<=';

/** Metadatos opcionales por contacto (CSV, Make, Shopify). */
export interface OutboundContactMeta {
  contactTicket?: number | null;
  /** Alineado con segmentation customerState */
  customerState?: 'new' | 'recurring' | string | null;
  cartTotal?: number | null;
  cartItemCount?: number | null;
  /** SKU, handle o id de producto para filtros de campaña */
  productHandle?: string | null;
}

function parseEuroNumber(raw: string): number | null {
  const t = (raw ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function compareOp(
  op: SegNumericCompareOp,
  left: number,
  right: number,
): boolean {
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    default:
      return false;
  }
}

/**
 * Evalúa reglas de segmentación guardadas en JSON frente a datos por contacto.
 * Si una regla está configurada y faltan datos en el contacto → no permitido (conservador).
 */
export function evaluateOutboundSegmentationForContact(
  campaignKind: string,
  segmentationNotes: string | undefined,
  contact: OutboundContactMeta,
): { ok: boolean; reason?: string } {
  const seg = parseOutboundSegmentationNotes(segmentationNotes);

  if (campaignKind === 'abandonedCart') {
    const avg = parseEuroNumber(seg.avgTicket);
    if (avg !== null && seg.avgTicket.trim()) {
      const ct = contact.contactTicket;
      if (ct === undefined || ct === null) {
        return {
          ok: false,
          reason:
            'Segmentación: falta ticket/importe del contacto para aplicar ticket medio.',
        };
      }
      if (!compareOp(seg.avgTicketOp as SegNumericCompareOp, ct, avg)) {
        return { ok: false, reason: 'Segmentación: ticket medio no cumple regla.' };
      }
    }
    if (
      seg.customerState &&
      contact.customerState &&
      contact.customerState !== seg.customerState
    ) {
      return { ok: false, reason: 'Segmentación: estado de cliente no coincide.' };
    }
    const cartV = parseEuroNumber(seg.cartValue);
    if (cartV !== null && seg.cartValue.trim()) {
      const total = contact.cartTotal;
      if (total === undefined || total === null) {
        return {
          ok: false,
          reason: 'Segmentación: falta valor de carrito en el contacto.',
        };
      }
      if (!compareOp(seg.cartValueOp as SegNumericCompareOp, total, cartV)) {
        return { ok: false, reason: 'Segmentación: valor de carrito no cumple.' };
      }
    }
    const itemsRule = parseInt(seg.cartItems, 10);
    if (Number.isFinite(itemsRule) && seg.cartItems.trim()) {
      const n = contact.cartItemCount;
      if (n === undefined || n === null) {
        return {
          ok: false,
          reason: 'Segmentación: falta número de ítems del carrito en el contacto.',
        };
      }
      if (!compareOp(seg.cartItemsOp as SegNumericCompareOp, n, itemsRule)) {
        return { ok: false, reason: 'Segmentación: ítems de carrito no cumplen.' };
      }
    }
    const prodRule = (seg.cartProducts || '').trim();
    if (
      prodRule &&
      prodRule !== 'products' &&
      prodRule !== '__any__' &&
      prodRule !== 'any'
    ) {
      const h = (contact.productHandle || '').trim();
      if (!h) {
        return {
          ok: false,
          reason: 'Segmentación: falta producto en el contacto para filtrar.',
        };
      }
      if (h !== prodRule) {
        return { ok: false, reason: 'Segmentación: producto no coincide.' };
      }
    }
    return { ok: true };
  }

  if (campaignKind === 'satisfactionSurvey') {
    const surveyT = parseEuroNumber(seg.surveyTicketValue);
    if (surveyT !== null && seg.surveyTicketValue.trim()) {
      const ct = contact.contactTicket;
      if (ct === undefined || ct === null) {
        return {
          ok: false,
          reason:
            'Segmentación: falta valor de ticket de compra en el contacto.',
        };
      }
      if (
        !compareOp(seg.surveyTicketOp as SegNumericCompareOp, ct, surveyT)
      ) {
        return {
          ok: false,
          reason: 'Segmentación: ticket de encuesta no cumple la regla.',
        };
      }
    }
    if (
      seg.customerState &&
      contact.customerState &&
      contact.customerState !== seg.customerState
    ) {
      return { ok: false, reason: 'Segmentación: estado de cliente no coincide.' };
    }
    return { ok: true };
  }

  if (campaignKind === 'paymentReminder') {
    const payT = parseEuroNumber(seg.paymentTicketValue);
    if (payT !== null && seg.paymentTicketValue.trim()) {
      const ct = contact.contactTicket;
      if (ct === undefined || ct === null) {
        return {
          ok: false,
          reason:
            'Segmentación: falta importe del contacto para recordatorio de pago.',
        };
      }
      if (
        !compareOp(seg.paymentTicketOp as SegNumericCompareOp, ct, payT)
      ) {
        return {
          ok: false,
          reason: 'Segmentación: importe no cumple regla de recordatorio.',
        };
      }
    }
    if (
      seg.customerState &&
      contact.customerState &&
      contact.customerState !== seg.customerState
    ) {
      return { ok: false, reason: 'Segmentación: estado de cliente no coincide.' };
    }
    return { ok: true };
  }

  if (campaignKind === 'postPurchase') {
    const freq = seg.purchaseFrequency;
    const cf = contact.customerState;
    if (freq === 'first' && cf === 'recurring') {
      return {
        ok: false,
        reason: 'Segmentación: campaña solo primera compra; contacto recurrente.',
      };
    }
    if (freq === 'repeat' && cf === 'new') {
      return {
        ok: false,
        reason: 'Segmentación: campaña solo recurrentes; contacto nuevo.',
      };
    }
    const pur = (seg.purchasedProduct || '').trim();
    if (
      pur &&
      pur !== 'products' &&
      pur !== '__any__' &&
      pur !== 'any'
    ) {
      const h = (contact.productHandle || '').trim();
      if (!h) {
        return {
          ok: false,
          reason: 'Segmentación: falta producto comprado en el contacto.',
        };
      }
      if (h !== pur) {
        return { ok: false, reason: 'Segmentación: producto comprado no coincide.' };
      }
    }
    return { ok: true };
  }

  if (campaignKind === 'customCsv' || campaignKind === 'customMake') {
    return { ok: true };
  }

  const avg = parseEuroNumber(seg.avgTicket);
  if (avg !== null && seg.avgTicket.trim()) {
    const ct = contact.contactTicket;
    if (ct === undefined || ct === null) {
      return {
        ok: false,
        reason: 'Segmentación: falta ticket del contacto.',
      };
    }
    if (!compareOp(seg.avgTicketOp as SegNumericCompareOp, ct, avg)) {
      return { ok: false, reason: 'Segmentación: ticket medio no cumple.' };
    }
  }
  if (
    seg.customerState &&
    contact.customerState &&
    contact.customerState !== seg.customerState
  ) {
    return { ok: false, reason: 'Segmentación: estado de cliente no coincide.' };
  }
  return { ok: true };
}
