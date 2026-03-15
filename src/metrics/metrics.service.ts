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
      // Los 7 días son subconjunto de 14 días: solo descargamos 14 días y mes, luego filtramos en memoria
      const { startDate: startDate7Days } = this.getLast7DaysRange();
      const { startDate: startDate14Days, endDate: endDate14Days } =
        this.getLast14DaysRange();
      const { startDate: startDateMonth, endDate: endDateMonth } =
        this.getLastMonthRange();

      const start7DaysIso = startDate7Days.toISOString();

      // 3. Obtener llamadas de todas las cuentas (2 peticiones por cuenta en lugar de 3)
      const allCalls14Days: TwilioCall[] = [];
      const allCallsMonth: TwilioCall[] = [];

      for (const account of twilioAccounts) {
        const [calls14Days, callsMonth] = await Promise.all([
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

        allCalls14Days.push(...calls14Days);
        allCallsMonth.push(...callsMonth);
      }

      // Filtrar en memoria los últimos 7 días desde el array de 14 días (sin petición extra)
      const allCalls7Days = allCalls14Days.filter((call) => {
        const callDate = call.start_time || call.date_created || '';
        return callDate >= start7DaysIso;
      });

      console.log(
        `[Metrics] Llamadas obtenidas de ${twilioAccounts.length} cuentas - Últimos 14 días: ${allCalls14Days.length} (7 días filtrados: ${allCalls7Days.length}), Último mes: ${allCallsMonth.length}`,
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

      // 4. Obtener llamadas necesarias (solo 2 peticiones a Twilio)
      // Las métricas históricas (duración, países, éxito) se leen de Firestore en el paso 5b
      const [callsLast14Days, callsLastMonth] = await Promise.all([
        this.fetchTwilioCalls(sid, token, startDate14Days, endDate14Days), // 14 días para comparación
        this.fetchTwilioCalls(sid, token, startDateMonth, endDateMonth),   // Mes actual para tipos y razones
      ]);

      console.log(
        `[Metrics] Llamadas obtenidas - Últimos 14 días: ${callsLast14Days.length}, Último mes: ${callsLastMonth.length}`,
      );

      // 5. Obtener registros de finalización desde Firestore (mes actual + mes anterior)
      // Solo necesitamos ~31 días: razonesFinalizacion usa callsLastMonth (mes actual)
      // y evaluacionExito ya usa metricas_historicas de Firestore (histórico acumulado)
      const terminacionesFirestore = await this.getCallTerminations(
        userId,
        twilioConfig.twilioAccountId,
        31,
      );

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

      // Métricas históricas: Firestore es la fuente principal (sin petición extra a Twilio)
      const duracionMediaLlamadas = this.calculateDuracionMediaLlamadas(
        [],
        historicalMetrics,
      );
      const paisesOrigen = this.calculatePaisesOrigen(
        [],
        historicalMetrics,
      );
      const evaluacionExito = this.calculateEvaluacionExito(
        [],
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
        updates['clienteColgo'] = increment(1);
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
    // Prioridad: datos históricos acumulados de Firestore (completo y sin límite de 90 días)
    if (historicalMetrics && historicalMetrics.totalLlamadas > 0) {
      console.log(
        `[Metrics] Evaluación éxito (Firestore histórico) - Exitosas: ${historicalMetrics.exitosas}, Parciales: ${historicalMetrics.parciales}, Fallidas: ${historicalMetrics.fallidas}`,
      );
      return {
        exitosas: historicalMetrics.exitosas,
        parciales: historicalMetrics.parciales,
        fallidas: historicalMetrics.fallidas,
      };
    }

    // Fallback: calcular desde llamadas de Twilio + registros de finalización
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
      `[Metrics] Evaluación éxito (Twilio fallback) - Exitosas: ${exitosasCount}, Parciales (silencio): ${parcialesCount}, Fallidas: ${fallidasCount} (no conectadas: ${noConectadasCount}, cliente colgó: ${clienteColgoCount}) | Registros Firestore: ${terminaciones.length}`,
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

    console.log(
      `[Webhook] +${durationMinutes.toFixed(2)} min en ${monthKey} (AccountSid: ${AccountSid})`,
    );
  }
}
