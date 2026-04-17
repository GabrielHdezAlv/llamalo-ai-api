import { DateTime } from 'luxon';

const DEFAULT_TZ = 'Europe/Madrid';

/** Comprueba si `tz` es un identificador IANA reconocido por Luxon. */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz?.trim()) return false;
  return DateTime.now().setZone(tz.trim()).isValid;
}

/**
 * Zona para métricas (semana/mes): perfil `metricsCalendarTimezone`, si no env o inválida
 * `METRICS_CALENDAR_TIMEZONE`, y por defecto Europe/Madrid.
 */
export function resolveMetricsTimezoneFromUser(
  userData: Record<string, unknown> | undefined | null,
): string {
  const fallback = getMetricsCalendarTimezone();
  const raw = userData?.metricsCalendarTimezone;
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s) return fallback;
  return isValidIanaTimezone(s) ? s : fallback;
}

/**
 * Zona horaria para períodos de negocio (semana lunes 00:01, mes día 1 00:01).
 * Override: `METRICS_CALENDAR_TIMEZONE` (IANA, p. ej. Europe/Madrid).
 */
export function getMetricsCalendarTimezone(): string {
  const t = process.env.METRICS_CALENDAR_TIMEZONE?.trim();
  return t || DEFAULT_TZ;
}

/** Lunes 00:01 en `timezone` de la semana ISO que contiene `instant`. */
export function getMonday001ForWeekContaining(
  instant: Date,
  timezone: string,
): DateTime {
  const d = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone);
  const daysFromMonday = d.weekday === 7 ? 6 : d.weekday - 1;
  return d
    .minus({ days: daysFromMonday })
    .set({ hour: 0, minute: 1, second: 0, millisecond: 0 });
}

/** Semana calendario actual: [lunes 00:01, lunes siguiente 00:01). */
export function getCurrentWeekRange001(
  timezone: string,
  now: Date = new Date(),
): { startInclusive: Date; endExclusive: Date } {
  const monday = getMonday001ForWeekContaining(now, timezone);
  const nextMonday = monday.plus({ weeks: 1 });
  return {
    startInclusive: monday.toJSDate(),
    endExclusive: nextMonday.toJSDate(),
  };
}

/** Semana calendario anterior inmediata. */
export function getPreviousWeekRange001(
  timezone: string,
  now: Date = new Date(),
): { startInclusive: Date; endExclusive: Date } {
  const monday = getMonday001ForWeekContaining(now, timezone);
  const prevMonday = monday.minus({ weeks: 1 });
  return {
    startInclusive: prevMonday.toJSDate(),
    endExclusive: monday.toJSDate(),
  };
}

/**
 * Rango para cargar Firestore: desde el lunes 00:01 de la semana anterior
 * hasta el instante anterior al lunes 00:01 de la semana siguiente (fin semana actual).
 */
export function getTwoWeekFetchRangeInclusive(
  timezone: string,
  now: Date = new Date(),
): { startInclusive: Date; endInclusive: Date } {
  const monday = getMonday001ForWeekContaining(now, timezone);
  const prevMonday = monday.minus({ weeks: 1 });
  const nextMonday = monday.plus({ weeks: 1 });
  return {
    startInclusive: prevMonday.toJSDate(),
    endInclusive: new Date(nextMonday.toMillis() - 1),
  };
}

/**
 * Mes calendario actual: [día 1 00:01, día 1 mes siguiente 00:01) en `timezone`.
 */
export function getCurrentMonthRange001(
  timezone: string,
  now: Date = new Date(),
): { startInclusive: Date; endInclusive: Date } {
  const dt = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(timezone);
  const monthStart = dt.startOf('month').set({
    hour: 0,
    minute: 1,
    second: 0,
    millisecond: 0,
  });
  const nextMonthStart = monthStart.plus({ months: 1 });
  return {
    startInclusive: monthStart.toJSDate(),
    endInclusive: new Date(nextMonthStart.toMillis() - 1),
  };
}

/** Clave `YYYY-MM` del mes en curso según el calendario de `timezone`. */
export function getCalendarMonthKey(
  timezone: string,
  now: Date = new Date(),
): string {
  return DateTime.fromJSDate(now, { zone: 'utc' })
    .setZone(timezone)
    .toFormat('yyyy-MM');
}

export function inRangeHalfOpen(
  callTimeMs: number,
  startInclusive: Date,
  endExclusive: Date,
): boolean {
  return (
    callTimeMs >= startInclusive.getTime() &&
    callTimeMs < endExclusive.getTime()
  );
}

export function isInInclusiveRange(
  callTimeMs: number,
  startInclusive: Date,
  endInclusive: Date,
): boolean {
  return (
    callTimeMs >= startInclusive.getTime() &&
    callTimeMs <= endInclusive.getTime()
  );
}
