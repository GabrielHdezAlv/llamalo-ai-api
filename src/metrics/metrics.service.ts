import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';
import {
  DashboardMetricsResponseDto,
  SummaryDto,
  AgenteDto,
  LlamadaExitosaPorDiaDto,
  MetricaConComparacionDto,
} from './dto/dashboard-metrics-response.dto';
import { MailerLiteService } from '../mailerlite/mailerlite.service';
import {
  TwilioDetailedMetricsResponseDto,
  ComparacionDiaAnteriorDto,
  ResumenComparativoSemanalDto,
  TiposLlamadasDto,
  PaisOrigenDto,
  EvaluacionExitoDto,
  RazonesFinalizacionDto,
  CallMetricsDto,
  DailyPeakHour,
} from './dto/twilio-detailed-metrics.dto';

interface TwilioCall {
  sid: string;
  duration: string;
  date_created: string; // Twilio devuelve snake_case
  start_time: string; // Twilio devuelve snake_case
  direction: string;
  from: string;
  to: string;
  status: string;
  /** Presente cuando el origen es Firestore (`llamadas_registradas`) */
  twilioAccountId?: number;
}

@Injectable()
export class MetricsService {
  private firestore = getFirestore();
  /** Fuente de verdad de listados de llamadas para métricas (escrita al cerrar sesión en StreamsGateway) */
  private readonly REGISTERED_CALLS_COLLECTION = 'llamadas_registradas';
  // Factor de ahorro: cada minuto de IA ahorra 2.5 minutos de trabajo manual
  private readonly TIEMPO_AHORRO_FACTOR = 2.5;

  constructor(private readonly mailerLiteService: MailerLiteService) {}

  /**
   * Persiste una llamada completada en Firestore (fuente de verdad para dashboards).
   * Idempotente por callSid (merge).
   */
  async saveRegisteredCall(params: {
    userId: string;
    twilioAccountId: number;
    callSid: string;
    durationSeconds: number;
    direction: 'inbound' | 'outbound';
    from: string;
    to: string;
    startedAtMs: number;
  }): Promise<void> {
    const {
      userId,
      twilioAccountId,
      callSid,
      durationSeconds,
      direction,
      from,
      to,
      startedAtMs,
    } = params;
    try {
      const startedAt = admin.firestore.Timestamp.fromMillis(startedAtMs);
      const endedAt = admin.firestore.Timestamp.fromMillis(
        startedAtMs + Math.max(0, durationSeconds) * 1000,
      );
      await this.firestore
        .collection(this.REGISTERED_CALLS_COLLECTION)
        .doc(callSid)
        .set(
          {
            userId,
            twilioAccountId,
            callSid,
            durationSeconds: Math.max(0, durationSeconds),
            direction,
            from: from || '',
            to: to || '',
            startedAt,
            endedAt,
            status: 'completed',
            recordedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error(
        `[Metrics] Error guardando llamada registrada ${callSid}:`,
        errorMessage,
      );
    }
  }

  /**
   * Cuentas Twilio del usuario (puede ser array vacío).
   */
  private async getTwilioAccountsOptional(userId: string): Promise<
    Array<{
      twilioAccountId: number;
      twilioSid: string;
      twilioToken: string;
    }>
  > {
    const userDocRef = this.firestore.collection('users').doc(userId);
    const userSnapshot = await userDocRef.get();
    if (!userSnapshot.exists) return [];
    const userData = userSnapshot.data() as Record<string, unknown>;
    return (
      (userData?.twilio as Array<{
        twilioAccountId: number;
        twilioSid: string;
        twilioToken: string;
      }>) || []
    );
  }

  private registeredDocToTwilioCall(
    d: admin.firestore.DocumentData,
  ): TwilioCall {
    const startedAt: Date =
      d.startedAt?.toDate?.() ?? d.endedAt?.toDate?.() ?? new Date();
    const endedAt: Date = d.endedAt?.toDate?.() ?? startedAt;
    const sid = (d.callSid as string) || (d.sid as string) || '';
    return {
      sid,
      duration: String(d.durationSeconds ?? 0),
      date_created: endedAt.toISOString(),
      start_time: startedAt.toISOString(),
      direction: (d.direction as string) || 'inbound',
      from: (d.from as string) || '',
      to: (d.to as string) || '',
      status: (d.status as string) || 'completed',
      twilioAccountId:
        typeof d.twilioAccountId === 'number' ? d.twilioAccountId : undefined,
    };
  }

  /**
   * Listado de llamadas desde Firestore (no usa API REST de Twilio).
   */
  private async fetchRegisteredCallsFromFirestore(
    userId: string,
    startDate: Date,
    endDate: Date,
    twilioAccountId?: number,
  ): Promise<TwilioCall[]> {
    try {
      const snap = await this.firestore
        .collection(this.REGISTERED_CALLS_COLLECTION)
        .where('userId', '==', userId)
        .where('endedAt', '>=', admin.firestore.Timestamp.fromDate(startDate))
        .where('endedAt', '<=', admin.firestore.Timestamp.fromDate(endDate))
        .get();

      const out: TwilioCall[] = [];
      snap.forEach((doc) => {
        const d = doc.data();
        if (
          twilioAccountId !== undefined &&
          d.twilioAccountId !== twilioAccountId
        ) {
          return;
        }
        out.push(this.registeredDocToTwilioCall(d));
      });
      return out;
    } catch (error) {
      console.error(
        '[Metrics] Error leyendo llamadas registradas:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  /**
   * Obtiene las métricas del dashboard de todas las cuentas Twilio del usuario
   * Incluye comparaciones semanales y nuevas métricas solicitadas
   */
  async getDashboardMetrics(
    userId: string,
  ): Promise<DashboardMetricsResponseDto> {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();
      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const twilioAccounts = await this.getTwilioAccountsOptional(userId);

      const { startDate: startDate7Days } = this.getLast7DaysRange();
      const { startDate: startDate14Days, endDate: endDate14Days } =
        this.getLast14DaysRange();
      const { startDate: startDateMonth, endDate: endDateMonth } =
        this.getLastMonthRange();

      const start7DaysIso = startDate7Days.toISOString();

      const earliestFetch = new Date(
        Math.min(startDate14Days.getTime(), startDateMonth.getTime()),
      );

      const allCallsFetched = await this.fetchRegisteredCallsFromFirestore(
        userId,
        earliestFetch,
        endDate14Days,
      );

      const allCalls14Days = allCallsFetched.filter((call) => {
        const t = new Date(call.start_time || call.date_created).getTime();
        return t >= startDate14Days.getTime() && t <= endDate14Days.getTime();
      });

      const allCallsMonth = allCallsFetched.filter((call) => {
        const t = new Date(call.start_time || call.date_created).getTime();
        return t >= startDateMonth.getTime() && t <= endDateMonth.getTime();
      });

      const allCalls7Days = allCalls14Days.filter((call) => {
        const callDate = call.start_time || call.date_created || '';
        return callDate >= start7DaysIso;
      });

      console.log(
        `[Metrics] Llamadas desde Firestore (${this.REGISTERED_CALLS_COLLECTION}) — cuentas Twilio en perfil: ${twilioAccounts.length}; 14d: ${allCalls14Days.length}, 7d filtrados: ${allCalls7Days.length}, mes: ${allCallsMonth.length}`,
      );

      const accountIdsForTerms =
        twilioAccounts.length > 0
          ? twilioAccounts.map((a) => a.twilioAccountId)
          : [
              ...new Set(
                allCallsFetched
                  .map((c) => c.twilioAccountId)
                  .filter((id): id is number => typeof id === 'number'),
              ),
            ];

      const terminacionesDashboard =
        accountIdsForTerms.length === 0
          ? []
          : (
              await Promise.all(
                accountIdsForTerms.map((id) =>
                  this.getCallTerminations(userId, id, 14),
                ),
              )
            ).flat();

      // 5. Calcular métricas con comparación semanal
      const resumen = this.calculateSummaryWithComparison(
        allCalls7Days,
        allCalls14Days,
        allCallsMonth,
        terminacionesDashboard,
      );

      // 6. Obtener agentes
      const agentes = await this.getAgentes(
        userId,
        resumen.minutos_ultimo_mes.actual,
      );

      // 7. Calcular llamadas exitosas de los últimos 7 días por día (cruzando con Firestore)
      const llamadasExitosasUltimos7Dias =
        this.calculateLlamadasExitosasPorDia(allCalls7Days, terminacionesDashboard);

      return {
        resumen,
        agentes,
        llamadas_exitosas_ultimos_7_dias: llamadasExitosasUltimos7Dias,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener las métricas: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Devuelve la clave del mes actual en formato "YYYY-MM".
   */
  private getCurrentMonthKey(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Obtiene el rango de fechas de los últimos 7 días
   */
  private getLast7DaysRange(): {
    startDate: Date;
    endDate: Date;
  } {
    const now = new Date();

    // EndDate: fin del día actual (23:59:59.999)
    const endDate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );

    // StartDate: inicio del día hace 6 días (00:00:00.000)
    // Restamos 6 días para obtener exactamente 7 días incluyendo hoy
    const weekAgo = new Date(now);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
    const startDate = new Date(
      Date.UTC(
        weekAgo.getUTCFullYear(),
        weekAgo.getUTCMonth(),
        weekAgo.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );

    return { startDate, endDate };
  }

  /**
   * Obtiene el rango de fechas de los últimos 14 días (para comparación semanal)
   */
  private getLast14DaysRange(): {
    startDate: Date;
    endDate: Date;
  } {
    const now = new Date();

    // EndDate: fin del día actual (23:59:59.999)
    const endDate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );

    // StartDate: inicio del día hace 13 días (00:00:00.000)
    // Restamos 13 días para obtener exactamente 14 días incluyendo hoy
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 13);
    const startDate = new Date(
      Date.UTC(
        twoWeeksAgo.getUTCFullYear(),
        twoWeeksAgo.getUTCMonth(),
        twoWeeksAgo.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );

    return { startDate, endDate };
  }

  /**
   * Calcula el resumen de métricas con comparación semanal
   */
  private calculateSummaryWithComparison(
    calls7Days: TwilioCall[],
    calls14Days: TwilioCall[],
    callsMonth: TwilioCall[],
    terminaciones: { motivo: string; fecha: string; callSid: string }[] = [],
  ): SummaryDto {
    // 1. Total de llamadas (últimos 7 días vs semana anterior) — cualquier status
    const totalLlamadasActual = calls7Days.length;
    const totalLlamadasAnterior = this.calculateCallsForPeriod(
      calls14Days,
      'semana_anterior',
    );
    const totalLlamadasVariacion = this.calculateVariation(
      totalLlamadasActual,
      totalLlamadasAnterior,
    );

    // 2. Llamadas exitosas: completed cuyo motivo de Firestore sea 'agente' (o sin registro)
    // Excluye las cortadas por el cliente (motivo='cliente') y por silencio (motivo='silencio')
    const motivoMap7Days = new Map<string, string>(
      terminaciones.map((t) => [t.callSid, t.motivo]),
    );
    const { startDate: start7Days } = this.getLast7DaysRange();
    const start7DaysStr = start7Days.toISOString().split('T')[0];

    const llamadasExitosasActual = calls7Days.filter((call) => {
      if (call.status !== 'completed') return false;
      const fecha = (call.start_time || call.date_created || '').substring(0, 10);
      if (fecha < start7DaysStr) return false;
      const motivo = motivoMap7Days.get(call.sid);
      // Sin registro en Firestore o motivo='agente' → exitosa
      return motivo !== 'cliente' && motivo !== 'silencio';
    }).length;

    // Para la semana anterior se usa el mismo motivoMap: las terminaciones de los últimos
    // 14 días ya incluyen registros de ambas semanas, por lo que el criterio es consistente
    const llamadasExitosasAnterior = this.calculateCallsForPeriod(
      calls14Days,
      'semana_anterior',
      true,
      motivoMap7Days,
    );
    const llamadasExitosasVariacion = this.calculateVariation(
      llamadasExitosasActual,
      llamadasExitosasAnterior,
    );

    // 3. Total de minutos del último mes vs semana anterior
    const minutosMesActual = Math.round(
      callsMonth.reduce(
        (total, call) => total + parseInt(call.duration || '0', 10),
        0,
      ) / 60,
    );
    const minutosMesAnterior = this.calculateMinutesForPeriod(
      calls14Days,
      'semana_anterior',
    );
    const minutosMesVariacion = this.calculateVariation(
      minutosMesActual,
      minutosMesAnterior,
    );

    // 4. Tiempo ahorrado (minutos × factor) vs semana anterior
    const tiempoAhorradoActual = Math.round(
      minutosMesActual * this.TIEMPO_AHORRO_FACTOR,
    );
    const tiempoAhorradoAnterior = Math.round(
      minutosMesAnterior * this.TIEMPO_AHORRO_FACTOR,
    );
    const tiempoAhorradoVariacion = this.calculateVariation(
      tiempoAhorradoActual,
      tiempoAhorradoAnterior,
    );

    // 5. Tasa de éxito (porcentaje de llamadas exitosas del último período)
    const tasaExito =
      totalLlamadasActual > 0
        ? Math.round(
            (llamadasExitosasActual / totalLlamadasActual) * 100 * 10,
          ) / 10
        : 0;

    return {
      total_llamadas: {
        actual: totalLlamadasActual,
        variacionPorcentual: totalLlamadasVariacion,
      },
      total_llamadas_exitosas: {
        actual: llamadasExitosasActual,
        variacionPorcentual: llamadasExitosasVariacion,
      },
      minutos_ultimo_mes: {
        actual: minutosMesActual,
        variacionPorcentual: minutosMesVariacion,
      },
      tiempo_ahorrado: {
        actual: tiempoAhorradoActual,
        variacionPorcentual: tiempoAhorradoVariacion,
      },
      tasa_exito: tasaExito,
    };
  }

  /**
   * Calcula la variación porcentual entre dos valores
   */
  private calculateVariation(actual: number, anterior: number): number {
    if (anterior === 0) {
      return actual > 0 ? 100 : 0;
    }
    return Math.round(((actual - anterior) / anterior) * 100 * 10) / 10;
  }

  /**
   * Calcula el total de llamadas para un período específico
   */
  private calculateCallsForPeriod(
    calls: TwilioCall[],
    period: 'semana_actual' | 'semana_anterior',
    soloExitosas: boolean = false,
    motivoMap: Map<string, string> = new Map(),
  ): number {
    const now = new Date();
    const diasRestar = period === 'semana_actual' ? 6 : 13;

    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - diasRestar);
    startDate.setUTCHours(0, 0, 0, 0);

    const endDate = new Date(now);
    if (period === 'semana_anterior') {
      endDate.setUTCDate(endDate.getUTCDate() - 7);
    }
    endDate.setUTCHours(23, 59, 59, 999);

    return calls.filter((call) => {
      const callDate = new Date(call.start_time || call.date_created || '');
      if (callDate < startDate || callDate > endDate) return false;

      if (soloExitosas) {
        if (call.status !== 'completed') return false;
        // Si hay datos de Firestore, excluir las cortadas por el cliente o silencio
        if (motivoMap.size > 0) {
          const motivo = motivoMap.get(call.sid);
          return motivo !== 'cliente' && motivo !== 'silencio';
        }
        return true;
      }

      return true;
    }).length;
  }

  /**
   * Calcula los total de minutos para un período específico
   */
  private calculateMinutesForPeriod(
    calls: TwilioCall[],
    period: 'semana_actual' | 'semana_anterior',
  ): number {
    const now = new Date();
    const diasRestar = period === 'semana_actual' ? 6 : 13;

    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - diasRestar);
    startDate.setUTCHours(0, 0, 0, 0);

    const endDate = new Date(now);
    if (period === 'semana_anterior') {
      endDate.setUTCDate(endDate.getUTCDate() - 7);
    }
    endDate.setUTCHours(23, 59, 59, 999);

    const totalSegundos = calls
      .filter((call) => {
        const callDate = new Date(call.start_time || call.date_created || '');
        return callDate >= startDate && callDate <= endDate;
      })
      .reduce((total, call) => total + parseInt(call.duration || '0', 10), 0);

    return Math.round(totalSegundos / 60);
  }

  /**
   * Calcula las llamadas exitosas de los últimos 7 días (simple, para dashboard)
   */
  private calculateLlamadasExitosasPorDia(
    calls: TwilioCall[],
    terminaciones: { motivo: string; fecha: string; callSid: string }[] = [],
  ): LlamadaExitosaPorDiaDto[] {
    const ultimos7Dias: LlamadaExitosaPorDiaDto[] = [];
    const hoy = new Date();

    // Mapa callSid → motivo para clasificación precisa
    const motivoMap = new Map<string, string>(
      terminaciones.map((t) => [t.callSid, t.motivo]),
    );

    for (let i = 6; i >= 0; i--) {
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      fecha.setUTCHours(0, 0, 0, 0);

      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      // Contar llamadas exitosas del día: completed donde el agente cerró correctamente
      const llamadasExitosasDelDia = calls.filter((call) => {
        if (call.status !== 'completed') return false;

        const fechaLlamada = call.start_time || call.date_created;
        if (!fechaLlamada) return false;

        const callDate = new Date(fechaLlamada);
        const callDateStr = `${callDate.getUTCFullYear()}-${String(callDate.getUTCMonth() + 1).padStart(2, '0')}-${String(callDate.getUTCDate()).padStart(2, '0')}`;
        if (callDateStr !== fechaStr) return false;

        // Si hay datos de Firestore, excluir las cortadas por cliente o silencio
        if (motivoMap.size > 0) {
          const motivo = motivoMap.get(call.sid);
          return motivo !== 'cliente' && motivo !== 'silencio';
        }

        return true;
      });

      ultimos7Dias.push({
        fecha: fechaStr,
        total: llamadasExitosasDelDia.length,
      });
    }

    return ultimos7Dias;
  }

  /**
   * Obtiene los agentes del usuario
   */
  private async getAgentes(
    userId: string,
    minutosTotales: number,
  ): Promise<AgenteDto[]> {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) return [];

      const userData = userSnapshot.data() as Record<string, unknown>;
      const tieneTwilioConfig = !!userData?.twilio;

      // Nueva estructura: agents[] (array de agentes)
      const agentsArray = (userData?.agents as Array<Record<string, unknown>>) || [];

      if (agentsArray.length > 0) {
        return agentsArray
          .filter((a) => a.name)
          .map((a) => ({
            nombre: a.name as string,
            tipo: (a.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
            minutos_totales: minutosTotales,
            estado: tieneTwilioConfig ? 'activo' : 'inactivo',
          }));
      }

      // Estructura antigua: agent (objeto único)
      const agentConfig = userData?.agent as Record<string, unknown> | undefined;
      if (agentConfig?.name) {
        return [
          {
            nombre: agentConfig.name as string,
            tipo: 'inbound',
            minutos_totales: minutosTotales,
            estado: tieneTwilioConfig ? 'activo' : 'inactivo',
          },
        ];
      }

      return [];
    } catch (error) {
      console.error('Error obteniendo agentes:', error);
      return [];
    }
  }

  /**
   * Calcula las llamadas de los últimos 7 días
   */
  /**
   * Obtiene métricas detalladas de Twilio
   * Incluye todas las métricas solicitadas para análisis avanzado
   */
  async getTwilioDetailedMetrics(
    userId: string,
    twilioAccountId?: number,
  ): Promise<TwilioDetailedMetricsResponseDto> {
    try {
      // 1. Obtener configuración de Twilio del usuario
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioArray =
        (userData?.twilio as Array<{
          twilioAccountId: number;
          twilioSid: string;
          twilioToken: string;
        }>) || [];

      let filterByAccountId: number | undefined;
      if (twilioAccountId !== undefined) {
        const n = Number(twilioAccountId);
        if (Number.isNaN(n)) {
          throw new BadRequestException('twilioAccountId inválido.');
        }
        if (twilioArray.length > 0) {
          const account = twilioArray.find(
            (acc) => acc.twilioAccountId === n,
          );
          if (!account) {
            throw new NotFoundException(
              `Cuenta de Twilio con ID ${twilioAccountId} no encontrada.`,
            );
          }
        }
        filterByAccountId = n;
      }

      const { startDate: startDate14Days, endDate: endDate14Days } =
        this.getLast14DaysRange();
      const { startDate: startDateMonth, endDate: endDateMonth } =
        this.getLastMonthRange();

      const [callsLast14Days, callsLastMonth] = await Promise.all([
        this.fetchRegisteredCallsFromFirestore(
          userId,
          startDate14Days,
          endDate14Days,
          filterByAccountId,
        ),
        this.fetchRegisteredCallsFromFirestore(
          userId,
          startDateMonth,
          endDateMonth,
          filterByAccountId,
        ),
      ]);

      console.log(
        `[Metrics] Métricas detalladas desde Firestore (${this.REGISTERED_CALLS_COLLECTION}) — 14d: ${callsLast14Days.length}, mes: ${callsLastMonth.length}`,
      );

      const accountIdsForTerminaciones =
        filterByAccountId !== undefined
          ? [filterByAccountId]
          : twilioArray.length > 0
            ? twilioArray.map((a) => a.twilioAccountId)
            : [
                ...new Set(
                  [...callsLast14Days, ...callsLastMonth]
                    .map((c) => c.twilioAccountId)
                    .filter((id): id is number => typeof id === 'number'),
                ),
              ];

      const terminacionesFirestore =
        accountIdsForTerminaciones.length === 0
          ? []
          : (
              await Promise.all(
                accountIdsForTerminaciones.map((id) =>
                  this.getCallTerminations(userId, id, 31),
                ),
              )
            ).flat();

      // 5b. Obtener métricas históricas acumuladas de Firestore (duración, países, éxito)
      const historicalMetrics = await this.getHistoricalMetrics(userId);

      // 6. Calcular todas las métricas
      const llamadasExitosasUltimos7Dias =
        this.calculateLlamadasExitosasPorDiaConComparacion(
          callsLast14Days,
          terminacionesFirestore,
        );
      const resumenComparativoSemanal = this.calculateResumenComparativoSemanal(
        llamadasExitosasUltimos7Dias,
      );

      // Minutos del mes: calcular directamente desde callsLastMonth (ya descargado, sin petición extra)
      const totalMinutosUltimoMes = this.calculateMinutosFromCalls(callsLastMonth);

      // Métricas históricas: Firestore es la fuente principal.
      // callsLastMonth se pasa como fallback para cuando el histórico de Firestore aún está vacío
      // (usuarios nuevos o llamadas previas a la implementación del acumulado).
      const duracionMediaLlamadas = this.calculateDuracionMediaLlamadas(
        callsLastMonth,
        historicalMetrics,
      );
      const paisesOrigen = this.calculatePaisesOrigen(
        callsLastMonth,
        historicalMetrics,
      );
      // Evaluación de éxito: mismo período y fuente que razonesFinalizacion (mes actual)
      // El histórico de Firestore actúa solo como fallback si no hay llamadas del mes
      const evaluacionExito = this.calculateEvaluacionExito(
        callsLastMonth,
        terminacionesFirestore,
        historicalMetrics,
      );

      // Métricas mensuales: usar callsLastMonth
      const tiposLlamadas = this.calculateTiposLlamadas(
        callsLastMonth,
        historicalMetrics,
      );
      const razonesFinalizacion = this.calculateRazonesFinalizacion(
        callsLastMonth,
        terminacionesFirestore,
      );

      const latenciaMedia = await this.calculateLatenciaMedia(
        userId,
        filterByAccountId,
      );
      const callMetricsByHour =
        this.calculateCallMetricsByHour(callsLast14Days);

      return {
        llamadasExitosasUltimos7Dias,
        resumenComparativoSemanal,
        totalMinutosUltimoMes,
        duracionMediaLlamadas,
        tiposLlamadas,
        paisesOrigen,
        evaluacionExito,
        razonesFinalizacion,
        latenciaMedia,
        callMetricsByHour,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener las métricas detalladas de Twilio: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Obtiene el rango de fechas del último mes (día 1 al último día)
   */
  private getLastMonthRange(): {
    startDate: Date;
    endDate: Date;
  } {
    const now = new Date();

    // StartDate: primer día del mes actual a las 00:00:00.000 UTC
    const startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );

    // EndDate: último día del mes actual a las 23:59:59.999 UTC
    const lastDayOfMonth = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        0, // Día 0 del siguiente mes = último día del mes actual
        23,
        59,
        59,
        999,
      ),
    );

    return { startDate, endDate: lastDayOfMonth };
  }

  /**
   * Obtiene todas las llamadas para análisis (sin límite de tiempo)
   */

  /**
   * Calcula las llamadas exitosas de los últimos 7 días con comparación semanal
   */
  private calculateLlamadasExitosasPorDiaConComparacion(
    calls: TwilioCall[],
    terminaciones: { motivo: string; fecha: string; callSid: string }[] = [],
  ): LlamadaExitosaPorDiaDto[] {
    const ultimos7Dias: LlamadaExitosaPorDiaDto[] = [];
    const hoy = new Date();

    // Mapa callSid → motivo para clasificación precisa desde Firestore
    const motivoMap = new Map<string, string>(
      terminaciones.map((t) => [t.callSid, t.motivo]),
    );

    // Obtener datos de los últimos 14 días para comparación
    const datosPorFecha = new Map<string, number>();

    // Procesar llamadas para tener un mapa de fechas con criterio consistente
    calls.forEach((call) => {
      if (call.status !== 'completed') return;

      // Si hay datos de Firestore, excluir las cortadas por el cliente o silencio
      if (motivoMap.size > 0) {
        const motivo = motivoMap.get(call.sid);
        if (motivo === 'cliente' || motivo === 'silencio') return;
      }

      const fechaLlamada = call.start_time || call.date_created;
      if (!fechaLlamada) return;

      const callDate = new Date(fechaLlamada);
      const year = callDate.getUTCFullYear();
      const month = String(callDate.getUTCMonth() + 1).padStart(2, '0');
      const day = String(callDate.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      datosPorFecha.set(fechaStr, (datosPorFecha.get(fechaStr) || 0) + 1);
    });

    // Generar los últimos 7 días con comparación
    for (let i = 6; i >= 0; i--) {
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      fecha.setUTCHours(0, 0, 0, 0);

      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      const totalActual = datosPorFecha.get(fechaStr) || 0;

      // Calcular comparación con la semana anterior (mismo día de la semana - 7 días)
      const fechaSemanaAnterior = new Date(fecha);
      fechaSemanaAnterior.setUTCDate(fechaSemanaAnterior.getUTCDate() - 7);

      const yearAnterior = fechaSemanaAnterior.getUTCFullYear();
      const monthAnterior = String(
        fechaSemanaAnterior.getUTCMonth() + 1,
      ).padStart(2, '0');
      const dayAnterior = String(fechaSemanaAnterior.getUTCDate()).padStart(
        2,
        '0',
      );
      const fechaStrAnterior = `${yearAnterior}-${monthAnterior}-${dayAnterior}`;

      const totalAnterior = datosPorFecha.get(fechaStrAnterior) || 0;

      // Calcular variación porcentual
      let variacionPorcentual = 0;
      if (totalAnterior > 0) {
        variacionPorcentual =
          Math.round(
            ((totalActual - totalAnterior) / totalAnterior) * 100 * 10,
          ) / 10;
      } else if (totalActual > 0) {
        // Si no había datos la semana anterior pero sí ahora, es un incremento infinito
        variacionPorcentual = 100;
      }

      const comparacion: ComparacionDiaAnteriorDto = {
        total: totalAnterior,
        variacionPorcentual,
      };

      ultimos7Dias.push({
        fecha: fechaStr,
        total: totalActual,
        comparacionSemanaAnterior: comparacion,
      });
    }

    return ultimos7Dias;
  }

  /**
   * Calcula el resumen comparativo semanal
   */
  private calculateResumenComparativoSemanal(
    llamadasDiarias: LlamadaExitosaPorDiaDto[],
  ): ResumenComparativoSemanalDto {
    const totalSemanaActual = llamadasDiarias.reduce(
      (sum, dia) => sum + dia.total,
      0,
    );
    const totalSemanaAnterior = llamadasDiarias.reduce((sum, dia) => {
      return sum + (dia.comparacionSemanaAnterior?.total || 0);
    }, 0);

    let variacionPorcentual = 0;
    if (totalSemanaAnterior > 0) {
      variacionPorcentual =
        Math.round(
          ((totalSemanaActual - totalSemanaAnterior) / totalSemanaAnterior) *
            100 *
            10,
        ) / 10;
    } else if (totalSemanaActual > 0) {
      variacionPorcentual = 100;
    }

    return {
      totalSemanaActual,
      totalSemanaAnterior,
      variacionPorcentual,
    };
  }

  /**
   * Suma las duraciones de un array de llamadas ya descargado y devuelve los minutos totales.
   * Síncrono: reutiliza datos en memoria, sin petición extra a Twilio.
   */
  private calculateMinutosFromCalls(calls: TwilioCall[]): number {
    const totalSegundos = calls.reduce((total, call) => {
      const duration = parseInt(call.duration || '0', 10);
      return total + duration;
    }, 0);

    const totalMinutos = Math.round((totalSegundos / 60) * 10) / 10;

    console.log(
      `[Metrics] Minutos último mes - Total llamadas: ${calls.length}, Total segundos: ${totalSegundos}, Total minutos: ${totalMinutos}`,
    );

    return totalMinutos;
  }

  /**
   * Calcula la latencia media de respuesta del agente en milisegundos
   */
  private async calculateLatenciaMedia(
    userId: string,
    twilioAccountId?: number,
  ): Promise<number> {
    try {
      // Usar los últimos 3 días para reflejar el rendimiento reciente
      // (la media mensual arrastraría llamadas malas de hace semanas)
      const threeDaysAgo = new Date();
      threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 2);
      threeDaysAgo.setUTCHours(0, 0, 0, 0);
      const startDateStr = threeDaysAgo.toISOString().split('T')[0]; // YYYY-MM-DD

      // Consultar colección de latencias agregadas
      let query = this.firestore
        .collection('latencias_agregadas')
        .where('userId', '==', userId)
        .where('periodo', '>=', startDateStr);

      if (twilioAccountId) {
        query = query.where('twilioAccountId', '==', twilioAccountId);
      }

      const snapshot = await query.get();

      if (snapshot.empty) {
        console.log(
          `[Metrics] No se encontraron datos de latencia para el usuario ${userId}`,
        );
        return 0;
      }

      // Recolectar todas las latencias del período
      const todasLasLatencias: number[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        const latencias = data.latencias || [];
        todasLasLatencias.push(...latencias);
      });

      if (todasLasLatencias.length === 0) {
        console.log(`[Metrics] No hay latencias registradas para el período`);
        return 0;
      }

      // Tomar solo las últimas 20 interacciones para una media más reactiva y realista
      // (evitando que latencias antiguas o anomalías corrompan la media mostrada al cliente)
      const RECENT_INTERACTIONS_LIMIT = 20;
      const ultimasLatencias = todasLasLatencias.slice(-RECENT_INTERACTIONS_LIMIT);

      // Calcular media
      const latenciaMedia = Math.round(
        ultimasLatencias.reduce((a, b) => a + b, 0) / ultimasLatencias.length,
      );

      console.log(
        `[Metrics] Latencia media calculada - Total mediciones (histórico): ${todasLasLatencias.length}, Usadas (últimas): ${ultimasLatencias.length}, Media: ${latenciaMedia}ms`,
      );

      return latenciaMedia;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error('[Metrics] Error calculando latencia media:', errorMessage);
      return 0;
    }
  }

  /**
   * Guarda una medición de latencia en la colección agregada diaria
   * Método para ser usado desde StreamsGateway
   */
  async saveLatencyMeasurement(
    userId: string,
    twilioAccountId: number,
    latenciaMs: number,
  ): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const docId = `${userId}_${twilioAccountId}_${today}`;
      const docRef = this.firestore.collection('latencias_agregadas').doc(docId);

      // Operación atómica: set con merge evita la race condition del patrón read-then-write.
      // arrayUnion añade el valor al array existente sin sobrescribir otras escrituras concurrentes.
      await docRef.set(
        {
          userId,
          twilioAccountId,
          periodo: today,
          latencias: admin.firestore.FieldValue.arrayUnion(latenciaMs),
          updatedAt: new Date(),
        },
        { merge: true },
      );

      console.log(
        `[Metrics] Latencia guardada - Usuario: ${userId}, Latencia: ${latenciaMs}ms, Día: ${today}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error('[Metrics] Error guardando latencia:', errorMessage);
    }
  }

  /**
   * Acumula métricas históricas en Firestore al finalizar cada llamada.
   * Colección: metricas_historicas / doc: userId
   * Usa FieldValue.increment para contadores atómicos sin sobrescribir datos anteriores.
   */
  async saveHistoricalMetrics(
    userId: string,
    duracionSegundos: number,
    direction: 'inbound' | 'outbound',
    motivo: 'agente' | 'cliente' | 'silencio' | 'error',
    paisPrefijo: string | null,
  ): Promise<void> {
    try {
      const docRef = this.firestore.collection('metricas_historicas').doc(userId);

      const increment = admin.firestore.FieldValue.increment;

      const updates: Record<string, admin.firestore.FieldValue | string> = {
        totalLlamadas: increment(1),
        totalSegundos: increment(duracionSegundos),
        updatedAt: new Date().toISOString(),
      };

      // Contadores por dirección
      if (direction === 'inbound') {
        updates['inbound'] = increment(1);
      } else {
        updates['outbound'] = increment(1);
      }

      // Contadores por motivo de finalización
      if (motivo === 'agente') {
        updates['exitosas'] = increment(1);
      } else if (motivo === 'silencio') {
        updates['parciales'] = increment(1);
      } else if (motivo === 'cliente') {
        updates['fallidas'] = increment(1);
        updates['clienteColgo'] = increment(1);
      } else {
        updates['fallidas'] = increment(1);
        updates['errorTecnico'] = increment(1);
      }

      // Contador por país de origen
      if (paisPrefijo) {
        updates[`paises.${paisPrefijo}`] = increment(1);
      } else {
        updates['paises.SIN_IDENTIFICAR'] = increment(1);
      }

      await docRef.set(updates, { merge: true });

      console.log(
        `[Metrics] Métricas históricas actualizadas - Usuario: ${userId}, Duración: ${duracionSegundos}s, Dirección: ${direction}, Motivo: ${motivo}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error('[Metrics] Error guardando métricas históricas:', errorMessage);
    }
  }

  /**
   * Lee las métricas históricas acumuladas de Firestore para un usuario.
   */
  async getHistoricalMetrics(userId: string): Promise<{
    totalLlamadas: number;
    totalSegundos: number;
    inbound: number;
    outbound: number;
    exitosas: number;
    parciales: number;
    fallidas: number;
    clienteColgo: number;
    errorTecnico: number;
    paises: Record<string, number>;
  } | null> {
    try {
      const docSnap = await this.firestore
        .collection('metricas_historicas')
        .doc(userId)
        .get();

      if (!docSnap.exists) return null;

      const data = docSnap.data() as Record<string, unknown>;
      return {
        totalLlamadas: (data?.totalLlamadas as number) || 0,
        totalSegundos: (data?.totalSegundos as number) || 0,
        inbound: (data?.inbound as number) || 0,
        outbound: (data?.outbound as number) || 0,
        exitosas: (data?.exitosas as number) || 0,
        parciales: (data?.parciales as number) || 0,
        fallidas: (data?.fallidas as number) || 0,
        clienteColgo: (data?.clienteColgo as number) || 0,
        errorTecnico: (data?.errorTecnico as number) || 0,
        paises: (data?.paises as Record<string, number>) || {},
      };
    } catch (error) {
      console.error('[Metrics] Error leyendo métricas históricas:', error);
      return null;
    }
  }

  /**
   * Guarda la razón de finalización de una llamada en Firestore
   * Colección: finalizaciones_llamadas / doc: userId_twilioAccountId_YYYY-MM
   */
  async saveCallTermination(
    userId: string,
    twilioAccountId: number,
    callSid: string,
    motivo: 'agente' | 'cliente' | 'silencio' | 'error',
    duracionSegundos: number,
  ): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const month = today.substring(0, 7); // YYYY-MM
      const docId = `${userId}_${twilioAccountId}_${month}`;

      const docRef = this.firestore
        .collection('finalizaciones_llamadas')
        .doc(docId);

      const registro = {
        motivo,
        duracionSegundos,
        fecha: today,
        registradoEn: new Date(),
      };

      // set+merge con dot-notation es atómico: evita la race condition del patrón
      // read-then-write cuando dos llamadas terminan simultáneamente para el mismo mes
      await docRef.set(
        {
          userId,
          twilioAccountId,
          mes: month,
          updatedAt: new Date(),
          [`registros.${callSid}`]: registro,
        },
        { merge: true },
      );

      console.log(
        `[Metrics] Finalización de llamada guardada - Usuario: ${userId}, CallSid: ${callSid}, Motivo: ${motivo}, Duración: ${duracionSegundos}s`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error('[Metrics] Error guardando finalización de llamada:', errorMessage);
    }
  }

  /**
   * Obtiene los registros de finalización de los últimos N días desde Firestore
   */
  private async getCallTerminations(
    userId: string,
    twilioAccountId: number,
    diasAtras: number = 31,
  ): Promise<{ motivo: string; fecha: string; callSid: string }[]> {
    try {
      const now = new Date();
      const meses: string[] = [];
      for (let i = 0; i < Math.ceil(diasAtras / 30) + 1; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        meses.push(d.toISOString().substring(0, 7));
      }

      const fechaCorte = new Date();
      fechaCorte.setDate(fechaCorte.getDate() - diasAtras);
      const fechaCorteStr = fechaCorte.toISOString().split('T')[0];

      // Leer todos los documentos en paralelo en lugar de secuencialmente
      const docSnapshots = await Promise.all(
        meses.map((mes) =>
          this.firestore
            .collection('finalizaciones_llamadas')
            .doc(`${userId}_${twilioAccountId}_${mes}`)
            .get(),
        ),
      );

      const registros: { motivo: string; fecha: string; callSid: string }[] = [];

      for (const docSnap of docSnapshots) {
        if (!docSnap.exists) continue;
        const data = docSnap.data();
        if (!data?.registros) continue;

        for (const [callSid, reg] of Object.entries(
          data.registros as Record<string, { motivo: string; fecha: string }>,
        )) {
          if (reg.fecha >= fechaCorteStr) {
            registros.push({ motivo: reg.motivo, fecha: reg.fecha, callSid });
          }
        }
      }

      return registros;
    } catch (error) {
      console.error('[Metrics] Error leyendo finalizaciones:', error);
      return [];
    }
  }

  private calculateDuracionMediaLlamadas(
    calls: TwilioCall[],
    historicalMetrics?: Awaited<ReturnType<typeof this.getHistoricalMetrics>>,
  ): number {
    // Prioridad: datos históricos de Firestore (más completos y rápidos)
    if (historicalMetrics && historicalMetrics.totalLlamadas > 0) {
      const duracionMediaSegundos =
        historicalMetrics.totalSegundos / historicalMetrics.totalLlamadas;
      const duracionMediaMinutos =
        Math.round((duracionMediaSegundos / 60) * 10) / 10;
      console.log(
        `[Metrics] Duración media (Firestore histórico) - Total llamadas: ${historicalMetrics.totalLlamadas}, Total segundos: ${historicalMetrics.totalSegundos}, Media minutos: ${duracionMediaMinutos}`,
      );
      return duracionMediaMinutos;
    }

    // Fallback: calcular desde llamadas de Twilio
    if (calls.length === 0) return 0;

    const totalSegundos = calls.reduce((total, call) => {
      const durationSegundos = parseInt(call.duration || '0', 10);
      return total + durationSegundos;
    }, 0);

    const duracionMediaSegundos = totalSegundos / calls.length;
    const duracionMediaMinutos =
      Math.round((duracionMediaSegundos / 60) * 10) / 10;

    console.log(
      `[Metrics] Duración media (Twilio fallback) - Total llamadas: ${calls.length}, Total segundos: ${totalSegundos}, Media minutos: ${duracionMediaMinutos}`,
    );

    return duracionMediaMinutos;
  }

  /**
   * Calcula la distribución de tipos de llamadas (inbound/outbound).
   * Usa llamadas del mes actual (callsLastMonth) como fuente primaria.
   * Los datos históricos de Firestore solo se usan como fallback si no hay llamadas del mes.
   */
  private calculateTiposLlamadas(
    calls: TwilioCall[],
    _historicalMetrics?: Awaited<ReturnType<typeof this.getHistoricalMetrics>>,
  ): TiposLlamadasDto {
    if (calls.length === 0) {
      return { inbound: 0, outbound: 0 };
    }

    const inboundCount = calls.filter(
      (call) => call.direction === 'inbound',
    ).length;
    const outboundCount = calls.filter(
      (call) => call.direction === 'outbound',
    ).length;

    console.log(
      `[Metrics] Tipos llamadas (mes actual) - Inbound: ${inboundCount}, Outbound: ${outboundCount}`,
    );

    return {
      inbound: inboundCount,
      outbound: outboundCount,
    };
  }

  /**
   * Calcula los países de origen de las llamadas.
   * Prioriza datos históricos de Firestore (metricas_historicas.paises) y usa Twilio como fallback.
   */
  private calculatePaisesOrigen(
    calls: TwilioCall[],
    historicalMetrics?: Awaited<ReturnType<typeof this.getHistoricalMetrics>>,
  ): PaisOrigenDto[] {
    // Prioridad: datos acumulados en Firestore (histórico completo)
    if (
      historicalMetrics &&
      Object.keys(historicalMetrics.paises).length > 0
    ) {
      const paisesCount = historicalMetrics.paises;
      const totalLlamadas = Object.values(paisesCount).reduce(
        (sum, v) => sum + v,
        0,
      );

      const paisesOrigen = Object.entries(paisesCount)
        .map(([pais, cantidad]) => ({
          pais: pais === 'SIN_IDENTIFICAR' ? 'SIN IDENTIFICAR' : pais,
          cantidad,
          porcentaje:
            totalLlamadas > 0
              ? Math.round((cantidad / totalLlamadas) * 100 * 10) / 10
              : 0,
        }))
        .sort((a, b) => b.cantidad - a.cantidad)
        .slice(0, 10);

      console.log(
        `[Metrics] Países origen (Firestore histórico): ${paisesOrigen.length}`,
      );
      return paisesOrigen;
    }

    // Fallback: calcular desde llamadas de Twilio
    const paisesCount: Record<string, number> = {};

    calls.forEach((call) => {
      if (
        call.from &&
        call.from !== 'anonymous' &&
        call.from !== 'restricted' &&
        call.from !== 'withheld' &&
        call.from !== '' &&
        call.from !== 'private'
      ) {
        const countryCode = this.extractCountryCode(call.from);
        if (countryCode) {
          paisesCount[countryCode] = (paisesCount[countryCode] || 0) + 1;
        }
      } else {
        paisesCount['SIN IDENTIFICAR'] =
          (paisesCount['SIN IDENTIFICAR'] || 0) + 1;
      }
    });

    const totalLlamadas = calls.length;
    const paisesOrigen = Object.entries(paisesCount)
      .map(([pais, cantidad]) => ({
        pais,
        cantidad,
        porcentaje:
          totalLlamadas > 0
            ? Math.round((cantidad / totalLlamadas) * 100 * 10) / 10
            : 0,
      }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 10);

    console.log(
      `[Metrics] Países origen (Twilio fallback): ${paisesOrigen.length}`,
    );

    return paisesOrigen;
  }

  /**
   * Extrae el código de país de un número de teléfono
   */
  extractCountryCodePublic(phoneNumber: string): string | null {
    return this.extractCountryCode(phoneNumber);
  }

  private extractCountryCode(phoneNumber: string): string | null {
    // Eliminar caracteres no numéricos excepto +
    const cleanPhone = phoneNumber.replace(/[^\d+]/g, '');

    if (cleanPhone.startsWith('+')) {
      // Intentar extraer código de país con validación
      const remainingDigits = cleanPhone.substring(1); // Quitar el +

      // Intentar 3 dígitos primero (para países como +212 Marruecos, +213 Argelia, etc.)
      if (remainingDigits.length >= 3) {
        const code3 = remainingDigits.substring(0, 3);
        if (this.isValidCountryCode(code3)) {
          return code3;
        }
      }

      // Intentar 2 dígitos (para países como +34 España, +52 México, +54 Argentina, etc.)
      if (remainingDigits.length >= 2) {
        const code2 = remainingDigits.substring(0, 2);
        if (this.isValidCountryCode(code2)) {
          return code2;
        }
      }

      // Intentar 1 dígito (para +1 EE.UU./Canadá, +7 Rusia/Kazajistán)
      if (remainingDigits.length >= 1) {
        const code1 = remainingDigits.substring(0, 1);
        if (this.isValidCountryCode(code1)) {
          return code1;
        }
      }
    }

    // Caso 2: Formato sin + (ej: 34XXX, 0034XXX)
    if (cleanPhone.length >= 10) {
      // Para números largos, intentar extraer los primeros dígitos como código de país
      // Priorizar códigos más largos primero (más específicos)
      if (cleanPhone.length >= 13) {
        const code3 = cleanPhone.substring(0, 3);
        if (this.isValidCountryCode(code3)) {
          return code3;
        }
      }

      if (cleanPhone.length >= 12) {
        const code2 = cleanPhone.substring(0, 2);
        if (this.isValidCountryCode(code2)) {
          return code2;
        }
      }

      const code1 = cleanPhone.substring(0, 1);
      if (this.isValidCountryCode(code1)) {
        return code1;
      }
    }

    return null;
  }

  /**
   * Verifica si un código es un código de país válido (simplificado)
   */
  private isValidCountryCode(code: string): boolean {
    // Lista de códigos de país comunes (ISO 3166-1 numeric)
    const validCountryCodes = new Set([
      '1',
      '7',
      '20',
      '27',
      '30',
      '31',
      '32',
      '33',
      '34',
      '36',
      '39',
      '40',
      '41',
      '43',
      '44',
      '45',
      '46',
      '47',
      '48',
      '49',
      '51',
      '52',
      '53',
      '54',
      '55',
      '56',
      '57',
      '58',
      '60',
      '61',
      '62',
      '63',
      '64',
      '65',
      '66',
      '81',
      '82',
      '84',
      '86',
      '90',
      '91',
      '92',
      '93',
      '94',
      '95',
      '98',
      '212',
      '213',
      '216',
      '218',
      '220',
      '221',
      '222',
      '223',
      '224',
      '225',
      '226',
      '227',
      '228',
      '229',
      '230',
      '231',
      '232',
      '233',
      '234',
      '235',
      '236',
      '237',
      '238',
      '239',
      '240',
      '241',
      '242',
      '243',
      '244',
      '245',
      '246',
      '247',
      '248',
      '249',
      '250',
      '251',
      '252',
      '253',
      '254',
      '255',
      '256',
      '257',
      '258',
      '260',
      '261',
      '262',
      '263',
      '264',
      '265',
      '266',
      '267',
      '268',
      '269',
      '290',
      '291',
      '297',
      '298',
      '299',
      '350',
      '351',
      '352',
      '353',
      '354',
      '355',
      '356',
      '357',
      '358',
      '359',
      '370',
      '371',
      '372',
      '373',
      '374',
      '375',
      '376',
      '377',
      '378',
      '380',
      '381',
      '382',
      '383',
      '385',
      '386',
      '387',
      '389',
      '420',
      '421',
      '423',
      '500',
      '501',
      '502',
      '503',
      '504',
      '505',
      '506',
      '507',
      '508',
      '509',
      '590',
      '591',
      '592',
      '593',
      '594',
      '595',
      '596',
      '597',
      '598',
      '599',
      '670',
      '672',
      '673',
      '674',
      '675',
      '676',
      '677',
      '678',
      '679',
      '680',
      '681',
      '682',
      '683',
      '684',
      '685',
      '686',
      '687',
      '688',
      '689',
      '690',
      '691',
      '692',
      '850',
      '852',
      '853',
      '855',
      '856',
      '880',
      '886',
      '960',
      '961',
      '962',
      '963',
      '964',
      '965',
      '966',
      '967',
      '968',
      '970',
      '971',
      '972',
      '973',
      '974',
      '975',
      '976',
      '977',
      '992',
      '993',
      '994',
      '995',
      '996',
      '998',
    ]);

    return validCountryCodes.has(code);
  }

  /**
   * Calcula la evaluación de éxito de las llamadas
   */
  private calculateEvaluacionExito(
    calls: TwilioCall[],
    terminaciones: { motivo: string; fecha: string; callSid: string }[] = [],
    historicalMetrics?: Awaited<ReturnType<typeof this.getHistoricalMetrics>>,
  ): EvaluacionExitoDto {
    // Fuente primaria: callsLastMonth + terminacionesFirestore (mismo período que razonesFinalizacion)
    // Garantiza que ambas métricas sean comparables entre sí (mismo universo de datos)
    if (calls.length > 0) {
      const motivoMap = new Map<string, string>(
        terminaciones.map((t) => [t.callSid, t.motivo]),
      );

      // Llamadas no conectadas (nunca llegaron al stream): siempre fallidas
      const noConectadasCount = calls.filter((call) =>
        ['failed', 'busy', 'no-answer', 'canceled'].includes(call.status),
      ).length;

      let exitosasCount = 0;
      let parcialesCount = 0;
      let clienteColgoCount = 0;

      for (const call of calls.filter((c) => c.status === 'completed')) {
        const motivo = motivoMap.get(call.sid);
        if (motivo === 'cliente') {
          clienteColgoCount++;
        } else if (motivo === 'silencio') {
          parcialesCount++;
        } else {
          // 'agente' o sin registro en Firestore → agente cerró correctamente
          exitosasCount++;
        }
      }

      const fallidasCount = noConectadasCount + clienteColgoCount;

      console.log(
        `[Metrics] Evaluación éxito (mes actual) - Exitosas: ${exitosasCount}, Parciales: ${parcialesCount}, Fallidas: ${fallidasCount} (no conectadas: ${noConectadasCount}, cliente colgó: ${clienteColgoCount}) | Registros Firestore: ${terminaciones.length}`,
      );

      return {
        exitosas: exitosasCount,
        parciales: parcialesCount,
        fallidas: fallidasCount,
      };
    }

    // Fallback: histórico de Firestore si no hay llamadas del mes (usuario nuevo o sin actividad reciente)
    if (historicalMetrics && historicalMetrics.totalLlamadas > 0) {
      console.log(
        `[Metrics] Evaluación éxito (Firestore histórico fallback) - Exitosas: ${historicalMetrics.exitosas}, Parciales: ${historicalMetrics.parciales}, Fallidas: ${historicalMetrics.fallidas}`,
      );
      return {
        exitosas: historicalMetrics.exitosas,
        parciales: historicalMetrics.parciales,
        fallidas: historicalMetrics.fallidas,
      };
    }

    return { exitosas: 0, parciales: 0, fallidas: 0 };
  }

  /**
   * Calcula las razones de finalización de las llamadas.
   * Combina datos de Twilio (para llamadas no conectadas) con registros precisos
   * de Firestore (para llamadas conectadas, donde Twilio siempre reporta 'completed').
   */
  private calculateRazonesFinalizacion(
    calls: TwilioCall[],
    terminaciones: { motivo: string; fecha: string; callSid: string }[] = [],
  ): RazonesFinalizacionDto {
    if (calls.length === 0 && terminaciones.length === 0) {
      return {
        completada: 0,
        clienteColgo: 0,
        sinRespuesta: 0,
        silencio: 0,
        errorTecnico: 0,
        tiempoAgotado: 0,
      };
    }

    // Construir mapa de callSid → motivo desde Firestore para lookup rápido
    const motivoMap = new Map<string, string>(
      terminaciones.map((t) => [t.callSid, t.motivo]),
    );

    // Contadores para llamadas conectadas (status=completed en Twilio)
    let completadaCount = 0;
    let clienteColgoCount = 0;
    let silencioCount = 0;

    for (const call of calls.filter((c) => c.status === 'completed')) {
      const motivo = motivoMap.get(call.sid);
      if (motivo === 'cliente') {
        clienteColgoCount++;
      } else if (motivo === 'silencio') {
        silencioCount++;
      } else {
        // 'agente' o sin registro en Firestore → se considera completada por el agente
        completadaCount++;
      }
    }

    // Llamadas no conectadas: se obtienen directamente del status de Twilio
    const sinRespuestaCount = calls.filter(
      (call) => call.status === 'no-answer',
    ).length;

    const errorTecnicoCount = calls.filter(
      (call) => call.status === 'failed',
    ).length;

    const tiempoAgotadoCount = calls.filter(
      (call) => call.status === 'busy',
    ).length;

    // Canceladas antes de conectar (el cliente rechazó antes de que contestara el agente)
    const canceladasCount = calls.filter(
      (call) => call.status === 'canceled',
    ).length;
    clienteColgoCount += canceladasCount;

    console.log(
      `[Metrics] Razones finalización - Completada: ${completadaCount}, Cliente colgó: ${clienteColgoCount}, Sin respuesta: ${sinRespuestaCount}, Silencio: ${silencioCount}, Error técnico: ${errorTecnicoCount}, Tiempo agotado: ${tiempoAgotadoCount} (${terminaciones.length} registros Firestore)`,
    );

    return {
      completada: completadaCount,
      clienteColgo: clienteColgoCount,
      sinRespuesta: sinRespuestaCount,
      silencio: silencioCount,
      errorTecnico: errorTecnicoCount,
      tiempoAgotado: tiempoAgotadoCount,
    };
  }

  /**
   * Calcula las métricas de llamadas por hora para análisis de hora pico
   */
  private calculateCallMetricsByHour(calls: TwilioCall[]): CallMetricsDto {
    const { startDate: startDate7Days, endDate: endDate7Days } =
      this.getLast7DaysRange();

    // Pre-agrupar todas las llamadas por fecha en una sola pasada O(N)
    // evitando el doble bucle O(7×N) anterior
    const callsByDate = new Map<string, { hour: number }[]>();
    for (const call of calls) {
      const fechaLlamada = call.start_time || call.date_created;
      if (!fechaLlamada) continue;
      const d = new Date(fechaLlamada);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const hour = d.getUTCHours();
      if (!callsByDate.has(dateStr)) callsByDate.set(dateStr, []);
      callsByDate.get(dateStr)!.push({ hour });
    }

    const dailyPeakHours: DailyPeakHour[] = [];
    const hoy = new Date();
    let totalCalls = 0;

    for (let i = 6; i >= 0; i--) {
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      const fechaStr = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}-${String(fecha.getUTCDate()).padStart(2, '0')}`;

      const hourlyCalls = new Array(24).fill(0);
      const callsDelDia = callsByDate.get(fechaStr) || [];

      for (const { hour } of callsDelDia) {
        hourlyCalls[hour]++;
      }

      const maxCalls = Math.max(...hourlyCalls);
      const peakHour = maxCalls > 0 ? hourlyCalls.indexOf(maxCalls) : 0;
      const dayTotal = callsDelDia.length;
      totalCalls += dayTotal;

      dailyPeakHours.push({
        date: fechaStr,
        peakHour,
        peakCallCount: maxCalls,
        totalDayCalls: dayTotal,
        hourlyCalls,
      });
    }

    return {
      startDate: startDate7Days,
      endDate: endDate7Days,
      dailyPeakHours,
      totalCalls,
    };
  }

  /**
   * Maneja el webhook de Twilio cuando una llamada finaliza.
   * Incrementa `minutesByMonth["YYYY-MM"]` en el documento del usuario en Firestore.
   * Twilio envía este POST al completarse una llamada (CallStatus = 'completed').
   */
  async handleTwilioCallWebhook(payload: Record<string, string>): Promise<void> {
    const { AccountSid, CallStatus, CallDuration } = payload;

    if (CallStatus !== 'completed') {
      return;
    }

    const durationSeconds = parseInt(CallDuration || '0', 10);
    if (durationSeconds <= 0) {
      return;
    }

    // 1. Buscar userId en el índice inverso O(1): twilio_index/{AccountSid} → userId
    let userDocRef: FirebaseFirestore.DocumentReference | null = null;

    const indexDoc = await this.firestore
      .collection('twilio_index')
      .doc(AccountSid)
      .get();

    if (indexDoc.exists) {
      const userId = (indexDoc.data() as Record<string, string>)?.userId;
      if (userId) {
        userDocRef = this.firestore.collection('users').doc(userId);
      }
    }

    // 2. Fallback: escanear toda la colección (cuentas conectadas antes del índice)
    if (!userDocRef) {
      console.warn(
        `[Webhook] AccountSid ${AccountSid} no encontrado en twilio_index, usando fallback (full scan)`,
      );
      const allUsersSnapshot = await this.firestore.collection('users').get();
      for (const doc of allUsersSnapshot.docs) {
        const data = doc.data() as Record<string, unknown>;
        const twilioAccounts = (data.twilio as Array<{ twilioSid: string }>) || [];
        if (twilioAccounts.some((acc) => acc.twilioSid === AccountSid)) {
          userDocRef = doc.ref;
          // Escribir índice para próximas llamadas (auto-reparación)
          this.firestore
            .collection('twilio_index')
            .doc(AccountSid)
            .set({ userId: doc.id, updatedAt: new Date().toISOString() }, { merge: true })
            .catch(() => {});
          break;
        }
      }
    }

    if (!userDocRef) {
      console.warn(`[Webhook] No se encontró usuario para AccountSid: ${AccountSid}`);
      return;
    }

    const durationMinutes = durationSeconds / 60;
    const monthKey = this.getCurrentMonthKey();

    await userDocRef.update({
      [`minutesByMonth.${monthKey}`]: admin.firestore.FieldValue.increment(durationMinutes),
    });

    // 🔄 Sincronizar con MailerLite (actualizar grupos de minutos usados)
    const userId = userDocRef.id;
    this.mailerLiteService.syncUser(userId).catch(() => {});

    console.log(
      `[Webhook] +${durationMinutes.toFixed(2)} min en ${monthKey} (AccountSid: ${AccountSid})`,
    );
  }
}
