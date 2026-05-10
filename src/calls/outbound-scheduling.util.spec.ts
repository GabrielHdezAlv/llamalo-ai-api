import { computeEnqueueNotBeforeIso } from './outbound-scheduling.util';

/** Ventana 24/7 + retraso inicial de carrito tipo 1h_abandon. */
const SCHEDULE_TEST = JSON.stringify({
  useBusinessHours: false,
  useCustomSchedule: true,
  customWeekdays: [true, true, true, true, true, true, true],
  customTimeFrom: '00:00',
  customTimeTo: '23:59',
  initialDelay: '1h_abandon',
  retriesCount: '3',
  retriesInterval: '4h',
  maxCallsPerDay: '2',
});

const SEGMENTATION_TEST = JSON.stringify({ country: 'es' });

describe('computeEnqueueNotBeforeIso', () => {
  it('solo suma initialDelay en abandonedCart cuando no hay eventAt', () => {
    const ref = new Date('2026-01-06T15:00:00.000Z');
    const tCart = computeEnqueueNotBeforeIso(
      'abandonedCart',
      SCHEDULE_TEST,
      SEGMENTATION_TEST,
      { referenceUtc: ref },
    );
    const tCsv = computeEnqueueNotBeforeIso(
      'customCsv',
      SCHEDULE_TEST,
      SEGMENTATION_TEST,
      { referenceUtc: ref },
    );
    expect(new Date(tCart).getTime()).toBeGreaterThan(new Date(tCsv).getTime());
  });

  it('usa eventAt como base temporal frente a solo referenceUtc', () => {
    const ref = new Date('2026-01-06T18:00:00.000Z');
    const eventAt = '2026-01-05T12:00:00.000Z';
    const withEv = computeEnqueueNotBeforeIso(
      'customCsv',
      SCHEDULE_TEST,
      SEGMENTATION_TEST,
      { referenceUtc: ref, eventAtIso: eventAt },
    );
    const noEv = computeEnqueueNotBeforeIso(
      'customCsv',
      SCHEDULE_TEST,
      SEGMENTATION_TEST,
      { referenceUtc: ref },
    );
    expect(new Date(withEv).getTime()).toBeLessThan(new Date(noEv).getTime());
  });
});
