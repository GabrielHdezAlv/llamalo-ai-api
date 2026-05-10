import { DateTime } from 'luxon';

export const OUTBOUND_SCHEDULE_TZ = 'Europe/Madrid';

export interface OutboundScheduleFormState {
  v?: number;
  useBusinessHours: boolean;
  useCustomSchedule: boolean;
  customWeekdays: boolean[];
  customTimeFrom: string;
  customTimeTo: string;
  initialDelay: string;
  retriesCount: string;
  retriesInterval: string;
  maxCallsPerDay: string;
}

export interface OutboundSegmentationFormState {
  v?: number;
  abandonTime: string;
  avgTicket: string;
  avgTicketOp: string;
  country: string;
  customerState: string;
  advancedOpen: boolean;
  cartProducts: string;
  cartValue: string;
  cartValueOp: string;
  cartItems: string;
  cartItemsOp: string;
  surveyTimeSincePurchase: string;
  surveyTicketValue: string;
  surveyTicketOp: string;
  purchasedProduct: string;
  purchaseFrequency: string;
  paymentDue: string;
  paymentTicketValue: string;
  paymentTicketOp: string;
}

const DEFAULT_SCHEDULE: OutboundScheduleFormState = {
  useBusinessHours: true,
  useCustomSchedule: false,
  customWeekdays: [true, true, true, true, true, false, false],
  customTimeFrom: '09:00',
  customTimeTo: '18:00',
  initialDelay: '1h_abandon',
  retriesCount: '3',
  retriesInterval: '4h',
  maxCallsPerDay: '2',
};

const DEFAULT_SEGMENTATION: OutboundSegmentationFormState = {
  abandonTime: '24h',
  avgTicket: '',
  avgTicketOp: '>',
  country: 'es',
  customerState: 'new',
  advancedOpen: true,
  cartProducts: 'products',
  cartValue: '',
  cartValueOp: '>',
  cartItems: '',
  cartItemsOp: '>',
  surveyTimeSincePurchase: '3h',
  surveyTicketValue: '',
  surveyTicketOp: '>',
  purchasedProduct: 'products',
  purchaseFrequency: 'first',
  paymentDue: '1h_before',
  paymentTicketValue: '',
  paymentTicketOp: '>',
};

const COUNTRY_PREFIXES: Record<string, string> = {
  es: '34',
  pt: '351',
  fr: '33',
  mx: '52',
};

export function parseOutboundScheduleNotes(
  raw: string | null | undefined,
): OutboundScheduleFormState {
  const trimmed = (raw ?? '').trim();
  if (!trimmed.startsWith('{')) {
    return { ...DEFAULT_SCHEDULE };
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<OutboundScheduleFormState>;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SCHEDULE };
    }
    return mergeSchedule(parsed);
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function mergeSchedule(
  parsed: Partial<OutboundScheduleFormState>,
): OutboundScheduleFormState {
  const d = { ...DEFAULT_SCHEDULE };
  const w = normalizeWeekdays(parsed.customWeekdays);
  return {
    ...d,
    ...parsed,
    customWeekdays: w,
    customTimeFrom:
      typeof parsed.customTimeFrom === 'string'
        ? parsed.customTimeFrom
        : d.customTimeFrom,
    customTimeTo:
      typeof parsed.customTimeTo === 'string'
        ? parsed.customTimeTo
        : d.customTimeTo,
  };
}

function normalizeWeekdays(w: unknown): boolean[] {
  const d = [...DEFAULT_SCHEDULE.customWeekdays];
  if (!Array.isArray(w) || w.length !== 7) {
    return d;
  }
  return w.map((x) => !!x);
}

export function parseOutboundSegmentationNotes(
  raw: string | null | undefined,
): OutboundSegmentationFormState {
  const trimmed = (raw ?? '').trim();
  if (!trimmed.startsWith('{')) {
    return { ...DEFAULT_SEGMENTATION };
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<OutboundSegmentationFormState>;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SEGMENTATION };
    }
    return { ...DEFAULT_SEGMENTATION, ...parsed };
  } catch {
    return { ...DEFAULT_SEGMENTATION };
  }
}

/** Índice 0 = lunes (como en el formulario Angular). */
export function mondayBasedWeekdayIndex(dt: DateTime): number {
  return dt.weekday - 1;
}

export function effectiveWeekdaysAndHours(schedule: OutboundScheduleFormState): {
  weekdays: boolean[];
  fromStr: string;
  toStr: string;
} {
  if (schedule.useCustomSchedule) {
    return {
      weekdays: normalizeWeekdays(schedule.customWeekdays),
      fromStr: schedule.customTimeFrom || DEFAULT_SCHEDULE.customTimeFrom,
      toStr: schedule.customTimeTo || DEFAULT_SCHEDULE.customTimeTo,
    };
  }
  return {
    weekdays: [true, true, true, true, true, false, false],
    fromStr: '09:00',
    toStr: '18:00',
  };
}

export function parseHmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hm ?? '').trim());
  if (!m) {
    return 9 * 60;
  }
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10) || 0));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10) || 0));
  return h * 60 + min;
}

export function isWithinCallingWindow(
  dt: DateTime,
  schedule: OutboundScheduleFormState,
): boolean {
  const { weekdays, fromStr, toStr } = effectiveWeekdaysAndHours(schedule);
  const idx = mondayBasedWeekdayIndex(dt);
  if (!weekdays[idx]) {
    return false;
  }
  const fromM = parseHmToMinutes(fromStr);
  const toM = parseHmToMinutes(toStr);
  const mins = dt.hour * 60 + dt.minute;
  return mins >= fromM && mins <= toM;
}

/** Avanza `t` hasta el siguiente instante dentro de la ventana de llamadas (misma zona). */
export function alignToNextCallingWindow(
  t: DateTime,
  schedule: OutboundScheduleFormState,
): DateTime {
  let cursor = t;
  for (let i = 0; i < 500; i++) {
    if (isWithinCallingWindow(cursor, schedule)) {
      return cursor;
    }
    const { weekdays, fromStr, toStr } = effectiveWeekdaysAndHours(schedule);
    const idx = mondayBasedWeekdayIndex(cursor);
    const fromM = parseHmToMinutes(fromStr);
    const toM = parseHmToMinutes(toStr);
    const dayStart = cursor.startOf('day');

    if (!weekdays[idx]) {
      cursor = dayStart.plus({ days: 1 });
      continue;
    }

    const windowStart = dayStart.plus({ minutes: fromM });
    const windowEnd = dayStart.plus({ minutes: toM });

    if (cursor < windowStart) {
      cursor = windowStart;
      continue;
    }
    if (cursor > windowEnd) {
      cursor = dayStart.plus({ days: 1 });
      continue;
    }
  }
  return t;
}

export function parseInitialDelayMs(initialDelay: string): number {
  switch (initialDelay) {
    case '30m_abandon':
      return 30 * 60 * 1000;
    case '1h_abandon':
      return 60 * 60 * 1000;
    case '2h_abandon':
      return 2 * 60 * 60 * 1000;
    case '24h_abandon':
      return 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}

export function parseRetryIntervalMs(interval: string): number {
  switch (interval) {
    case '1h':
      return 60 * 60 * 1000;
    case '2h':
      return 2 * 60 * 60 * 1000;
    case '4h':
      return 4 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    default:
      return 4 * 60 * 60 * 1000;
  }
}

/** Demora mínima inferida por tipo de campaña + segmentación (sin datos por contacto). */
export function segmentationMinimumDelayMs(
  campaignKind: string,
  segmentation: OutboundSegmentationFormState,
): number {
  switch (campaignKind) {
    case 'satisfactionSurvey':
      return parseShortHorizonToMs(segmentation.surveyTimeSincePurchase);
    case 'abandonedCart':
      return parseAbandonTimeToMs(segmentation.abandonTime);
    case 'paymentReminder':
      return parsePaymentDueToMs(segmentation.paymentDue);
    default:
      return 0;
  }
}

function parseShortHorizonToMs(v: string): number {
  switch (v) {
    case '1h':
      return 60 * 60 * 1000;
    case '3h':
      return 3 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    default:
      return 3 * 60 * 60 * 1000;
  }
}

function parseAbandonTimeToMs(v: string): number {
  switch (v) {
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '48h':
      return 48 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function parsePaymentDueToMs(v: string): number {
  switch (v) {
    case '1h_before':
      return 60 * 60 * 1000;
    case '24h_before':
      return 24 * 60 * 60 * 1000;
    case '48h_before':
      return 48 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

/**
 * Calcula el primer instante permitido para intentar la llamada.
 * - `initialDelay` del JSON de programación solo aplica a campaña **carrito abandonado** (opción B producto).
 * - Si `eventAt` existe (abandono/compra real), la base temporal es ese instante + demoras de segmentación
 *   (+ `initialDelay` solo si abandonedCart); si no, la referencia es `reference` (típicamente "ahora").
 */
export function computeEnqueueNotBeforeLuxon(
  campaignKind: string,
  scheduleNotes: string | undefined,
  segmentationNotes: string | undefined,
  opts: {
    reference?: DateTime;
    eventAt?: DateTime | null;
  } = {},
): DateTime {
  const schedule = parseOutboundScheduleNotes(scheduleNotes);
  const segmentation = parseOutboundSegmentationNotes(segmentationNotes);
  const ref =
    opts.reference ?? DateTime.now().setZone(OUTBOUND_SCHEDULE_TZ);
  const eventAt = opts.eventAt
    ? opts.eventAt.setZone(OUTBOUND_SCHEDULE_TZ)
    : null;

  if (eventAt) {
    let t = eventAt;
    const segMs = segmentationMinimumDelayMs(campaignKind, segmentation);
    t = t.plus({ milliseconds: segMs });
    if (campaignKind === 'abandonedCart') {
      t = t.plus({
        milliseconds: parseInitialDelayMs(schedule.initialDelay),
      });
    }
    return alignToNextCallingWindow(t, schedule);
  }

  const extraMs = segmentationMinimumDelayMs(campaignKind, segmentation);
  const initialMs =
    campaignKind === 'abandonedCart'
      ? parseInitialDelayMs(schedule.initialDelay)
      : 0;
  let t = ref.plus({ milliseconds: initialMs + extraMs });
  t = alignToNextCallingWindow(t, schedule);
  return t;
}

export function computeInitialNotBeforeLuxon(
  campaignKind: string,
  scheduleNotes: string | undefined,
  segmentationNotes: string | undefined,
  reference: DateTime,
): DateTime {
  return computeEnqueueNotBeforeLuxon(
    campaignKind,
    scheduleNotes,
    segmentationNotes,
    { reference },
  );
}

export function computeInitialNotBeforeIso(
  campaignKind: string,
  scheduleNotes: string | undefined,
  segmentationNotes: string | undefined,
  referenceUtc: Date = new Date(),
): string {
  const ref = DateTime.fromJSDate(referenceUtc, { zone: 'utc' }).setZone(
    OUTBOUND_SCHEDULE_TZ,
  );
  return computeEnqueueNotBeforeLuxon(
    campaignKind,
    scheduleNotes,
    segmentationNotes,
    { reference: ref },
  )
    .toUTC()
    .toISO()!;
}

export function computeEnqueueNotBeforeIso(
  campaignKind: string,
  scheduleNotes: string | undefined,
  segmentationNotes: string | undefined,
  opts: {
    referenceUtc?: Date;
    eventAtIso?: string | null;
  } = {},
): string {
  const ref = opts.referenceUtc
    ? DateTime.fromJSDate(opts.referenceUtc, { zone: 'utc' }).setZone(
        OUTBOUND_SCHEDULE_TZ,
      )
    : DateTime.now().setZone(OUTBOUND_SCHEDULE_TZ);
  const eventAt =
    opts.eventAtIso && opts.eventAtIso.trim()
      ? DateTime.fromISO(opts.eventAtIso.trim(), { setZone: true })
      : null;
  if (eventAt && !eventAt.isValid) {
    return computeEnqueueNotBeforeLuxon(
      campaignKind,
      scheduleNotes,
      segmentationNotes,
      { reference: ref },
    )
      .toUTC()
      .toISO()!;
  }
  return computeEnqueueNotBeforeLuxon(
    campaignKind,
    scheduleNotes,
    segmentationNotes,
    { reference: ref, eventAt: eventAt ?? undefined },
  )
    .toUTC()
    .toISO()!;
}

export function phoneMatchesCountrySegmentation(
  e164Phone: string,
  segmentation: OutboundSegmentationFormState,
): boolean {
  const country = (segmentation.country || '').trim().toLowerCase();
  const prefix = COUNTRY_PREFIXES[country];
  if (!prefix) {
    return true;
  }
  const digits = e164Phone.replace(/\D/g, '');
  return digits.startsWith(prefix);
}

export function maxRetriesAllowed(schedule: OutboundScheduleFormState): number {
  const n = parseInt(schedule.retriesCount || '3', 10);
  if (!Number.isFinite(n) || n < 0) {
    return 3;
  }
  return Math.min(10, n);
}

export function maxCallsPerDayLimit(schedule: OutboundScheduleFormState): number {
  const n = parseInt(schedule.maxCallsPerDay || '2', 10);
  if (!Number.isFinite(n) || n < 1) {
    return 2;
  }
  return Math.min(20, n);
}

/** Primera apertura de ventana el día siguiente (o más tarde) desde `from`. */
export function nextDayWindowOpenLuxon(
  from: DateTime,
  schedule: OutboundScheduleFormState,
): DateTime {
  let day = from.startOf('day').plus({ days: 1 });
  for (let i = 0; i < 400; i++) {
    const { weekdays, fromStr } = effectiveWeekdaysAndHours(schedule);
    const idx = mondayBasedWeekdayIndex(day);
    if (weekdays[idx]) {
      const fromM = parseHmToMinutes(fromStr);
      return day.plus({ minutes: fromM });
    }
    day = day.plus({ days: 1 });
  }
  return from.plus({ days: 1 });
}

export function scheduleRetryNotBeforeLuxon(
  schedule: OutboundScheduleFormState,
  reference: DateTime,
): DateTime {
  const intervalMs = parseRetryIntervalMs(schedule.retriesInterval);
  let t = reference.plus({ milliseconds: intervalMs });
  t = alignToNextCallingWindow(t, schedule);
  return t;
}
