import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';
import {
  DashboardMetricsResponseDto,
  SummaryDto,
  AgenteDto,
  LlamadaExitosaPorDiaDto,
  MetricaConComparacionDto,
} from './dto/dashboard-metrics-response.dto';
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
}

interface TwilioCallsResponse {
  calls: TwilioCall[];
  page: number;
  page_size: number;
  uri: string;
  first_page_uri: string;
  previous_page_uri: string | null;
  next_page_uri: string | null;
}

@Injectable()
export class MetricsService {
  private firestore = getFirestore();
  // Factor de ahorro: cada minuto de IA ahorra 2.5 minutos de trabajo manual
  private readonly TIEMPO_AHORRO_FACTOR = 2.5;

  /**
   * Obtiene todas las cuentas Twilio de un usuario
   */
  private async getAllTwilioAccounts(userId: string): Promise<
    Array<{
      twilioAccountId: number;
      twilioSid: string;
      twilioToken: string;
    }>
  > {
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

    if (twilioArray.length === 0) {
      throw new NotFoundException(
        'Configuración de Twilio no encontrada para el usuario.',
      );
    }

    return twilioArray;
  }

  /**
   * Obtiene las métricas del dashboard de todas las cuentas Twilio del usuario
   * Incluye comparaciones semanales y nuevas métricas solicitadas
   */
  async getDashboardMetrics(
    userId: string,
  ): Promise<DashboardMetricsResponseDto> {
    try {
      // 1. Obtener todas las cuentas Twilio del usuario
      const twilioAccounts = await this.getAllTwilioAccounts(userId);

      // 2. Calcular rangos de fechas
      const { startDate: startDate7Days, endDate: endDate7Days } =
        this.getLast7DaysRange();
      const { startDate: startDate14Days, endDate: endDate14Days } =
        this.getLast14DaysRange();
      const { startDate: startDateMonth, endDate: endDateMonth } =
        this.getLastMonthRange();

      // 3. Obtener llamadas de todas las cuentas para diferentes períodos
      const allCalls7Days: TwilioCall[] = [];
      const allCalls14Days: TwilioCall[] = [];
      const allCallsMonth: TwilioCall[] = [];

      for (const account of twilioAccounts) {
        const [calls7Days, calls14Days, callsMonth] = await Promise.all([
          this.fetchTwilioCalls(
            account.twilioSid,
            account.twilioToken,
            startDate7Days,
            endDate7Days,
          ),
          this.fetchTwilioCalls(
            account.twilioSid,
            account.twilioToken,
            startDate14Days,
            endDate14Days,
          ),
          this.fetchTwilioCalls(
            account.twilioSid,
            account.twilioToken,
            startDateMonth,
            endDateMonth,
          ),
        ]);

        allCalls7Days.push(...calls7Days);
        allCalls14Days.push(...calls14Days);
        allCallsMonth.push(...callsMonth);
      }

      console.log(
        `[Metrics] Llamadas obtenidas de ${twilioAccounts.length} cuentas - Últimos 7 días: ${allCalls7Days.length}, Últimos 14 días: ${allCalls14Days.length}, Último mes: ${allCallsMonth.length}`,
      );

      // 4. Obtener registros de finalización desde Firestore para todas las cuentas
      // Se usa la primera cuenta como referencia (misma lógica que en métricas detalladas)
      const terminacionesDashboard = await Promise.all(
        twilioAccounts.map((acc) =>
          this.getCallTerminations(userId, acc.twilioAccountId, 14),
        ),
      ).then((results) => results.flat());

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

      // 7. Calcular llamadas exitosas de los últimos 7 días por día
      const llamadasExitosasUltimos7Dias =
        this.calculateLlamadasExitosasPorDia(allCalls7Days);

      // 8. Persistir minutos del mes actual en Firebase (red de seguridad)
      // Guardamos el mayor valor entre lo ya almacenado y lo recién calculado
      // para no perder datos si se eliminan agentes/números
      this.persistMonthlyMinutes(userId, resumen.minutos_ultimo_mes.actual).catch(
        (err) => console.error('[Metrics] Error al persistir minutesByMonth:', err),
      );

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
   * Persiste los minutos del mes actual en `minutesByMonth["YYYY-MM"]` en Firestore,
   * tomando el mayor entre el valor ya almacenado y el recién calculado desde Twilio.
   * Se llama de forma no bloqueante (fire-and-forget) al obtener métricas.
   */
  private async persistMonthlyMinutes(userId: string, twilioMinutes: number): Promise<void> {
    const userDocRef = this.firestore.collection('users').doc(userId);
    const snapshot = await userDocRef.get();
    if (!snapshot.exists) return;

    const monthKey = this.getCurrentMonthKey();
    const data = snapshot.data() as Record<string, unknown>;
    const minutesByMonth = (data?.minutesByMonth as Record<string, number>) ?? {};
    const stored = minutesByMonth[monthKey] ?? 0;

    if (twilioMinutes > stored) {
      await userDocRef.update({
        [`minutesByMonth.${monthKey}`]: twilioMinutes,
      });
    }
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
   * Obtiene todas las llamadas de Twilio en el rango de fechas
   * Si el rango es muy grande (>30 días), divide la consulta en múltiples consultas más pequeñas
   */
  private async fetchTwilioCalls(
    sid: string,
    token: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TwilioCall[]> {
    // Calcular días de diferencia
    const diffTime = endDate.getTime() - startDate.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // Si el rango es mayor a 30 días, dividir en múltiples consultas
    if (diffDays > 30) {
      return this.fetchTwilioCallsInChunks(sid, token, startDate, endDate, 30);
    }

    return this.fetchTwilioCallsSingle(sid, token, startDate, endDate);
  }

  /**
   * Obtiene llamadas dividiendo el rango en chunks más pequeños
   */
  private async fetchTwilioCallsInChunks(
    sid: string,
    token: string,
    startDate: Date,
    endDate: Date,
    chunkDays: number,
  ): Promise<TwilioCall[]> {
    const allCalls: TwilioCall[] = [];
    let currentStart = new Date(startDate);

    while (currentStart < endDate) {
      const currentEnd = new Date(currentStart);
      currentEnd.setUTCDate(currentEnd.getUTCDate() + chunkDays);

      // Asegurar que no exceda el endDate
      if (currentEnd > endDate) {
        currentEnd.setTime(endDate.getTime());
      }

      const chunkCalls = await this.fetchTwilioCallsSingle(
        sid,
        token,
        currentStart,
        currentEnd,
      );
      allCalls.push(...chunkCalls);

      // Mover al siguiente chunk
      currentStart = new Date(currentEnd);
      currentStart.setUTCDate(currentStart.getUTCDate() + 1);
    }

    return allCalls;
  }

  /**
   * Obtiene todas las llamadas de Twilio en el rango de fechas (consulta única)
   */
  private async fetchTwilioCallsSingle(
    sid: string,
    token: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TwilioCall[]> {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const allCalls: TwilioCall[] = [];
    let nextPageUri: string | null = null;

    // Formatear fechas para Twilio API usando StartTime y EndTime
    // Según la documentación oficial de Twilio, debemos usar StartTime y EndTime, no DateCreated
    // Twilio acepta formato YYYY-MM-DD o YYYY-MM-DDTHH:mm:ssZ
    // Usamos formato completo con hora para mayor precisión
    const formatDateForTwilio = (date: Date): string => {
      // Formato ISO 8601 completo con UTC
      return date.toISOString();
    };

    // Usar las fechas directamente (ya están en UTC)
    const startDateStr = formatDateForTwilio(startDate);
    const endDateStr = formatDateForTwilio(endDate);

    do {
      const url: string =
        nextPageUri ||
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?StartTime>=${encodeURIComponent(startDateStr)}&StartTime<=${encodeURIComponent(endDateStr)}&Direction=inbound&PageSize=1000`;

      try {
        const response = await axios.get<TwilioCallsResponse>(url, {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        });

        const calls = response.data.calls;
        if (calls && Array.isArray(calls)) {
          allCalls.push(...calls);
        }

        nextPageUri = response.data.next_page_uri || null;
      } catch (error) {
        // Log detallado del error (sin exponer información sensible)
        if (axios.isAxiosError(error)) {
          console.error(
            `[Metrics] Error de Twilio API:`,
            error.response?.status,
            error.response?.statusText,
          );
          // 🔒 No loggear el contenido completo de error.response?.data que podría contener tokens o información sensible
          // Solo loggear el tipo de error si existe
          if (error.response?.data) {
            const errorType =
              typeof error.response.data === 'object' &&
              error.response.data !== null
                ? (error.response.data as { message?: string; error?: string })
                    ?.message ||
                  (error.response.data as { message?: string; error?: string })
                    ?.error ||
                  'Error desconocido'
                : 'Error desconocido';
            console.error(`[Metrics] Tipo de error: ${errorType}`);
          }
        } else {
          const errorMessage =
            error instanceof Error ? error.message : 'Error desconocido';
          console.error(
            '[Metrics] Error obteniendo llamadas de Twilio:',
            errorMessage,
          );
        }
        // Si falla, retornar las llamadas que se hayan obtenido hasta ahora
        break;
      }
    } while (nextPageUri);

    return allCalls;
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
  ): LlamadaExitosaPorDiaDto[] {
    const ultimos7Dias: LlamadaExitosaPorDiaDto[] = [];
    const hoy = new Date();

    for (let i = 6; i >= 0; i--) {
      // Calcular la fecha usando UTC para evitar problemas de zona horaria
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      fecha.setUTCHours(0, 0, 0, 0);

      // Obtener fecha en formato YYYY-MM-DD (usando UTC para consistencia)
      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      // Contar llamadas exitosas de ese día
      const llamadasExitosasDelDia = calls.filter((call) => {
        if (call.status !== 'completed') return false;

        // Usar start_time si está disponible, sino usar date_created como fallback
        const fechaLlamada = call.start_time || call.date_created;
        if (!fechaLlamada) return false;

        const callDate = new Date(fechaLlamada);
        const callYear = callDate.getUTCFullYear();
        const callMonth = String(callDate.getUTCMonth() + 1).padStart(2, '0');
        const callDay = String(callDate.getUTCDate()).padStart(2, '0');
        const callDateStr = `${callYear}-${callMonth}-${callDay}`;
        return callDateStr === fechaStr;
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
      // Obtener el usuario actual
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        return [];
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentConfig = userData?.agent as
        | Record<string, unknown>
        | undefined;

      const agentes: AgenteDto[] = [];

      // Si el usuario tiene configuración de agente, agregarlo
      if (agentConfig && agentConfig.name) {
        const tieneTwilioConfig = !!userData?.twilio;
        const minutosPorAgente = minutosTotales; // Mismo valor para todos

        agentes.push({
          nombre: agentConfig.name as string,
          tipo: 'inbound', // Siempre inbound por ahora
          minutos_totales: minutosPorAgente,
          estado: tieneTwilioConfig ? 'activo' : 'inactivo',
        });
      }

      // Si no hay agentes, retornar array vacío o un agente por defecto
      if (agentes.length === 0) {
        return [];
      }

      return agentes;
    } catch (error) {
      console.error('Error obteniendo agentes:', error);
      return [];
    }
  }

  /**
   * Calcula las llamadas de los últimos 7 días
   */
  private calculateLast7Days(calls: TwilioCall[]): LlamadaExitosaPorDiaDto[] {
    // Obtener los últimos 7 días
    const ultimos7Dias: LlamadaExitosaPorDiaDto[] = [];
    const hoy = new Date();

    for (let i = 6; i >= 0; i--) {
      // Calcular la fecha usando UTC para evitar problemas de zona horaria
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      fecha.setUTCHours(0, 0, 0, 0);

      // Obtener fecha en formato YYYY-MM-DD (usando UTC para consistencia)
      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      // Contar llamadas de ese día
      // Usar start_time si está disponible, sino usar date_created como fallback
      // Las fechas de Twilio vienen en UTC, así que comparamos en UTC
      const llamadasDelDia = calls.filter((call) => {
        // Intentar usar start_time primero, si no está disponible usar date_created
        const fechaLlamada = call.start_time || call.date_created;
        if (!fechaLlamada) {
          console.warn(
            `[Metrics] Llamada sin start_time ni date_created: ${call.sid}`,
          );
          return false;
        }
        const callDate = new Date(fechaLlamada);
        const callYear = callDate.getUTCFullYear();
        const callMonth = String(callDate.getUTCMonth() + 1).padStart(2, '0');
        const callDay = String(callDate.getUTCDate()).padStart(2, '0');
        const callDateStr = `${callYear}-${callMonth}-${callDay}`;
        return callDateStr === fechaStr;
      });

      ultimos7Dias.push({
        fecha: fechaStr,
        total: llamadasDelDia.length,
      });
    }

    // Resumen final para verificar que todas las llamadas se estén contando
    const totalContadas = ultimos7Dias.reduce((sum, dia) => sum + dia.total, 0);
    const llamadasSinFecha = calls.filter(
      (call) => !call.start_time && !call.date_created,
    ).length;

    console.log(
      `[Metrics] Resumen final - Total recibidas: ${calls.length}, Total contadas: ${totalContadas}, Sin fecha: ${llamadasSinFecha}`,
    );

    if (totalContadas + llamadasSinFecha !== calls.length) {
      console.warn(
        `[Metrics] ADVERTENCIA: Hay ${calls.length - totalContadas - llamadasSinFecha} llamadas que no se están contando`,
      );
    }

    return ultimos7Dias;
  }

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

      if (twilioArray.length === 0) {
        throw new NotFoundException(
          'Configuración de Twilio no encontrada para el usuario.',
        );
      }

      // 2. Seleccionar la cuenta de Twilio correcta
      let twilioConfig: {
        twilioAccountId: number;
        twilioSid: string;
        twilioToken: string;
      };

      if (twilioAccountId !== undefined) {
        const account = twilioArray.find(
          (acc) => acc.twilioAccountId === twilioAccountId,
        );
        if (!account) {
          throw new NotFoundException(
            `Cuenta de Twilio con ID ${twilioAccountId} no encontrada.`,
          );
        }
        twilioConfig = account;
      } else {
        // Si no se especifica, usar la primera cuenta
        twilioConfig = twilioArray[0];
      }

      const sid = twilioConfig.twilioSid;
      const token = twilioConfig.twilioToken;

      if (!sid || !token) {
        throw new BadRequestException(
          'Credenciales de Twilio no configuradas.',
        );
      }

      // 3. Obtener datos para diferentes períodos
      const { startDate: startDate14Days, endDate: endDate14Days } =
        this.getLast14DaysRange();
      const { startDate: startDateMonth, endDate: endDateMonth } =
        this.getLastMonthRange();

      // 4. Obtener todas las llamadas necesarias
      const [callsLast14Days, callsLastMonth, allCallsForAnalysis] =
        await Promise.all([
          this.fetchTwilioCalls(sid, token, startDate14Days, endDate14Days), // 14 días para comparación
          this.fetchTwilioCalls(sid, token, startDateMonth, endDateMonth),
          this.fetchAllCallsForAnalysis(sid, token), // Para análisis completos
        ]);

      console.log(
        `[Metrics] Llamadas obtenidas - Últimos 14 días: ${callsLast14Days.length}, Último mes: ${callsLastMonth.length}, Total análisis: ${allCallsForAnalysis.length}`,
      );

      // 5. Calcular todas las métricas
      const llamadasExitosasUltimos7Dias =
        this.calculateLlamadasExitosasPorDiaConComparacion(callsLast14Days);
      const resumenComparativoSemanal = this.calculateResumenComparativoSemanal(
        llamadasExitosasUltimos7Dias,
      );
      const totalMinutosUltimoMes = await this.calculateTotalMinutosUltimoMes(
        sid,
        token,
      );
      const duracionMediaLlamadas =
        this.calculateDuracionMediaLlamadas(allCallsForAnalysis);
      const tiposLlamadas = this.calculateTiposLlamadas(allCallsForAnalysis);
      const paisesOrigen = this.calculatePaisesOrigen(allCallsForAnalysis);
      // Obtener registros de finalización desde Firestore para clasificación exacta
      // Usar el id real de la cuenta seleccionada, no el parámetro opcional que puede ser undefined
      const terminacionesFirestore = await this.getCallTerminations(
        userId,
        twilioConfig.twilioAccountId,
        90,
      );

      const evaluacionExito = this.calculateEvaluacionExito(
        allCallsForAnalysis,
        terminacionesFirestore,
      );
      const razonesFinalizacion = this.calculateRazonesFinalizacion(
        allCallsForAnalysis,
        terminacionesFirestore,
      );

      const latenciaMedia = await this.calculateLatenciaMedia(
        userId,
        twilioAccountId,
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
  private async fetchAllCallsForAnalysis(
    sid: string,
    token: string,
  ): Promise<TwilioCall[]> {
    // Para análisis completos, obtenemos llamadas de los últimos 90 días
    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - 90);
    startDate.setUTCHours(0, 0, 0, 0);

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

    return this.fetchTwilioCalls(sid, token, startDate, endDate);
  }

  /**
   * Calcula las llamadas exitosas de los últimos 7 días con comparación semanal
   */
  private calculateLlamadasExitosasPorDiaConComparacion(
    calls: TwilioCall[],
  ): LlamadaExitosaPorDiaDto[] {
    const ultimos7Dias: LlamadaExitosaPorDiaDto[] = [];
    const hoy = new Date();

    // Obtener datos de los últimos 14 días para comparación
    const datosPorFecha = new Map<string, number>();

    // Primero, procesar todas las llamadas para tener un mapa de fechas
    calls.forEach((call) => {
      if (call.status !== 'completed') return;

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
   * Calcula el total de minutos del último mes sumando duraciones de llamadas
   */
  private async calculateTotalMinutosUltimoMes(
    sid: string,
    token: string,
  ): Promise<number> {
    try {
      // Obtener rango del último mes
      const { startDate, endDate } = this.getLastMonthRange();

      // Obtener todas las llamadas del mes
      const calls = await this.fetchTwilioCalls(sid, token, startDate, endDate);

      // Sumar duraciones de todas las llamadas (inbound + outbound)
      const totalSegundos = calls.reduce((total, call) => {
        const duration = parseInt(call.duration || '0', 10);
        return total + duration;
      }, 0);

      // Convertir a minutos
      const totalMinutos = Math.round((totalSegundos / 60) * 10) / 10; // Redondear a 1 decimal

      console.log(
        `[Metrics] Minutos último mes (suma directa) - Total llamadas: ${calls.length}, Total segundos: ${totalSegundos}, Total minutos: ${totalMinutos}`,
      );

      // Opcional: Comparar con método de Usage Records para debug
      try {
        const usageRecordsMinutes =
          await this.calculateTotalMinutosUltimoMesUsageRecords(sid, token);
        console.log(
          `[Metrics] Comparación métodos - Suma directa: ${totalMinutos} min, Usage Records: ${usageRecordsMinutes} min, Diferencia: ${Math.abs(totalMinutos - usageRecordsMinutes)} min`,
        );
      } catch (error) {
        console.log(
          `[Metrics] No se pudo comparar con Usage Records: ${error}`,
        );
      }

      return totalMinutos;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error(
        '[Metrics] Error obteniendo minutos del último mes (suma directa):',
        errorMessage,
      );
      return 0;
    }
  }

  /**
   * Calcula el total de minutos del último mes usando Usage Records API (método original)
   */
  private async calculateTotalMinutosUltimoMesUsageRecords(
    sid: string,
    token: string,
  ): Promise<number> {
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');

      // Obtener tanto inbound como outbound calls del mes
      const [inboundResponse, outboundResponse] = await Promise.all([
        axios.get(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json?Category=calls-inbound`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
            },
          },
        ),
        axios.get(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json?Category=calls-outbound`,
          {
            headers: {
              Authorization: `Basic ${auth}`,
            },
          },
        ),
      ]);

      const inboundMinutes = parseInt(
        inboundResponse.data.usage_records?.[0]?.usage || '0',
        10,
      );
      const outboundMinutes = parseInt(
        outboundResponse.data.usage_records?.[0]?.usage || '0',
        10,
      );

      return inboundMinutes + outboundMinutes;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Calcula la latencia media de respuesta del agente en milisegundos
   */
  private async calculateLatenciaMedia(
    userId: string,
    twilioAccountId?: number,
  ): Promise<number> {
    try {
      // Obtener fecha de inicio del último mes
      const { startDate } = this.getLastMonthRange();
      const startDateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD

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

      // Calcular media
      const latenciaMedia = Math.round(
        todasLasLatencias.reduce((a, b) => a + b, 0) / todasLasLatencias.length,
      );

      console.log(
        `[Metrics] Latencia media calculada - Total mediciones: ${todasLasLatencias.length}, Media: ${latenciaMedia}ms`,
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

      const docRef = this.firestore
        .collection('latencias_agregadas')
        .doc(docId);

      // Obtener documento actual si existe
      const docSnapshot = await docRef.get();

      if (docSnapshot.exists) {
        // Si existe, añadir la nueva latencia al array existente
        const data = docSnapshot.data();
        const latencias = (data && data.latencias) || [];
        latencias.push(latenciaMs);

        await docRef.update({
          latencias,
          updatedAt: new Date(),
        });
      } else {
        // Si no existe, crear nuevo documento
        await docRef.set({
          userId,
          twilioAccountId,
          periodo: today,
          latencias: [latenciaMs],
          updatedAt: new Date(),
        });
      }

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

      const docSnap = await docRef.get();

      if (docSnap.exists) {
        // update() con dot-notation sí actualiza campos anidados dentro del mapa 'registros'
        await docRef.update({
          updatedAt: new Date(),
          [`registros.${callSid}`]: registro,
        });
      } else {
        // Crear el documento con el mapa 'registros' correctamente estructurado
        await docRef.set({
          userId,
          twilioAccountId,
          mes: month,
          updatedAt: new Date(),
          registros: {
            [callSid]: registro,
          },
        });
      }

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
    diasAtras: number = 90,
  ): Promise<{ motivo: string; fecha: string; callSid: string }[]> {
    try {
      const now = new Date();
      const meses: string[] = [];
      for (let i = 0; i < Math.ceil(diasAtras / 30) + 1; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        meses.push(d.toISOString().substring(0, 7));
      }

      const registros: { motivo: string; fecha: string; callSid: string }[] = [];

      for (const mes of meses) {
        const docId = `${userId}_${twilioAccountId}_${mes}`;
        const docSnap = await this.firestore
          .collection('finalizaciones_llamadas')
          .doc(docId)
          .get();

        if (!docSnap.exists) continue;

        const data = docSnap.data();
        if (!data?.registros) continue;

        const fechaCorte = new Date();
        fechaCorte.setDate(fechaCorte.getDate() - diasAtras);
        const fechaCorteStr = fechaCorte.toISOString().split('T')[0];

        for (const [callSid, reg] of Object.entries(data.registros as Record<string, { motivo: string; fecha: string }>)) {
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

  private calculateDuracionMediaLlamadas(calls: TwilioCall[]): number {
    if (calls.length === 0) return 0;

    const totalSegundos = calls.reduce((total, call) => {
      const durationSegundos = parseInt(call.duration || '0', 10);
      return total + durationSegundos;
    }, 0);

    const duracionMediaSegundos = totalSegundos / calls.length;
    const duracionMediaMinutos =
      Math.round((duracionMediaSegundos / 60) * 10) / 10; // Redondear a 1 decimal

    console.log(
      `[Metrics] Duración media - Total llamadas: ${calls.length}, Total segundos: ${totalSegundos}, Media minutos: ${duracionMediaMinutos}`,
    );

    return duracionMediaMinutos;
  }

  /**
   * Calcula la distribución porcentual de tipos de llamadas
   */
  private calculateTiposLlamadas(calls: TwilioCall[]): TiposLlamadasDto {
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
      `[Metrics] Tipos llamadas - Inbound: ${inboundCount} (${Math.round((inboundCount / calls.length) * 100)}%), Outbound: ${outboundCount} (${Math.round((outboundCount / calls.length) * 100)}%)`,
    );

    return {
      inbound: inboundCount,
      outbound: outboundCount,
    };
  }

  /**
   * Calcula los países de origen de las llamadas
   */
  private calculatePaisesOrigen(calls: TwilioCall[]): PaisOrigenDto[] {
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
        // Extraer código de país del número de teléfono
        const countryCode = this.extractCountryCode(call.from);
        if (countryCode) {
          paisesCount[countryCode] = (paisesCount[countryCode] || 0) + 1;
        }
      } else {
        // Contar números ocultos/privados
        paisesCount['SIN IDENTIFICAR'] =
          (paisesCount['SIN IDENTIFICAR'] || 0) + 1;
      }
    });

    // Convertir a array y ordenar por cantidad descendente
    const totalLlamadas = calls.length;
    const paisesOrigen = Object.entries(paisesCount)
      .map(([pais, cantidad]) => ({
        pais,
        cantidad,
        porcentaje: Math.round((cantidad / totalLlamadas) * 100 * 10) / 10, // Redondear a 1 decimal
      }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 10); // Top 10 países

    console.log(`[Metrics] Países origen encontrados: ${paisesOrigen.length}`);

    return paisesOrigen;
  }

  /**
   * Extrae el código de país de un número de teléfono
   */
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
  ): EvaluacionExitoDto {
    if (calls.length === 0 && terminaciones.length === 0) {
      return { exitosas: 0, parciales: 0, fallidas: 0 };
    }

    // Construir mapa callSid → motivo desde Firestore
    const motivoMap = new Map<string, string>(
      terminaciones.map((t) => [t.callSid, t.motivo]),
    );

    // Llamadas no conectadas (nunca pasaron por el stream): siempre fallidas
    const noConectadasCount = calls.filter((call) =>
      ['failed', 'busy', 'no-answer', 'canceled'].includes(call.status),
    ).length;

    // Llamadas conectadas (completed): clasificar con datos de Firestore
    let exitosasCount = 0;  // Agente cerró correctamente
    let parcialesCount = 0; // Silencio prolongado (cliente conectado pero no respondía)
    let clienteColgoCount = 0; // Cliente colgó a mitad

    for (const call of calls.filter((c) => c.status === 'completed')) {
      const motivo = motivoMap.get(call.sid);
      if (motivo === 'cliente') {
        clienteColgoCount++;
      } else if (motivo === 'silencio') {
        parcialesCount++;
      } else {
        // 'agente' o sin registro → llamada completada correctamente
        exitosasCount++;
      }
    }

    // Fallidas = no conectadas + cliente colgó a mitad
    const fallidasCount = noConectadasCount + clienteColgoCount;

    console.log(
      `[Metrics] Evaluación éxito - Exitosas: ${exitosasCount}, Parciales (silencio): ${parcialesCount}, Fallidas: ${fallidasCount} (no conectadas: ${noConectadasCount}, cliente colgó: ${clienteColgoCount}) | Registros Firestore: ${terminaciones.length}`,
    );

    return {
      exitosas: exitosasCount,
      parciales: parcialesCount,
      fallidas: fallidasCount,
    };
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

    const dailyPeakHours: DailyPeakHour[] = [];
    const hoy = new Date();
    let totalCalls = 0;

    // Procesar cada día de los últimos 7 días
    for (let i = 6; i >= 0; i--) {
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - i);
      fecha.setUTCHours(0, 0, 0, 0);

      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      // Inicializar array de 24 horas para este día
      const hourlyCalls = new Array(24).fill(0);

      // Filtrar llamadas de este día y agrupar por hora
      const callsDelDia = calls.filter((call) => {
        const fechaLlamada = call.start_time || call.date_created;
        if (!fechaLlamada) return false;

        const callDate = new Date(fechaLlamada);
        const callYear = callDate.getUTCFullYear();
        const callMonth = String(callDate.getUTCMonth() + 1).padStart(2, '0');
        const callDay = String(callDate.getUTCDate()).padStart(2, '0');
        const callDateStr = `${callYear}-${callMonth}-${callDay}`;

        return callDateStr === fechaStr;
      });

      // Contar llamadas por hora
      callsDelDia.forEach((call) => {
        const fechaLlamada = call.start_time || call.date_created;
        if (fechaLlamada) {
          const callDate = new Date(fechaLlamada);
          const hour = callDate.getUTCHours();
          hourlyCalls[hour]++;
        }
      });

      // Encontrar hora pico
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

    // Buscar manualmente el usuario que tiene esta cuenta Twilio
    // (Firestore no soporta array-contains con objetos parciales)
    const usersRef = this.firestore.collection('users');
    const allUsersSnapshot = await usersRef.get();

    let userDocRef: FirebaseFirestore.DocumentReference | null = null;

    for (const doc of allUsersSnapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      const twilioAccounts = (data.twilio as Array<{ twilioSid: string }>) || [];
      if (twilioAccounts.some((acc) => acc.twilioSid === AccountSid)) {
        userDocRef = doc.ref;
        break;
      }
    }

    if (!userDocRef) {
      console.warn(`[Webhook] No se encontró usuario para AccountSid: ${AccountSid}`);
      return;
    }

    const durationMinutes = durationSeconds / 60;
    const monthKey = this.getCurrentMonthKey();

    // Incrementar el contador del mes actual usando notación de punto para campo anidado
    await userDocRef.update({
      [`minutesByMonth.${monthKey}`]: admin.firestore.FieldValue.increment(durationMinutes),
    });

    console.log(
      `[Webhook] +${durationMinutes.toFixed(2)} min en ${monthKey} (AccountSid: ${AccountSid})`,
    );
  }
}
