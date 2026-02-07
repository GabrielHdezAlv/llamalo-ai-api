import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { getFirestore } from '../firebase/firebase.config';
import {
  DashboardMetricsResponseDto,
  SummaryDto,
  AgenteDto,
  LlamadaPorDiaDto,
} from './dto/dashboard-metrics-response.dto';
import {
  TwilioDetailedMetricsResponseDto,
  LlamadaExitosaPorDiaDto,
  ComparacionDiaAnteriorDto,
  ResumenComparativoSemanalDto,
  TiposLlamadasDto,
  PaisOrigenDto,
  EvaluacionExitoDto,
  RazonesFinalizacionDto,
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
   * Obtiene las métricas del dashboard
   * Siempre retorna datos de los últimos 7 días
   */
  async getDashboardMetrics(
    userId: string,
  ): Promise<DashboardMetricsResponseDto> {
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

      // Usar la primera cuenta de Twilio para las métricas
      const twilioConfig = twilioArray[0];

      const sid = twilioConfig.twilioSid;
      const token = twilioConfig.twilioToken;

      if (!sid || !token) {
        throw new BadRequestException(
          'Credenciales de Twilio no configuradas.',
        );
      }

      // 2. Calcular fechas de los últimos 7 días
      const { startDate, endDate } = this.getLast7DaysRange();

      // 3. Obtener todas las llamadas de los últimos 7 días desde Twilio
      const calls = await this.fetchTwilioCalls(sid, token, startDate, endDate);

      console.log(`[Metrics] Llamadas obtenidas de Twilio: ${calls.length}`);

      // 4. Calcular resumen (últimos 7 días)
      const resumen = this.calculateSummary(calls);

      // 5. Obtener agentes (con minutos de los últimos 7 días)
      const agentes = await this.getAgentes(userId, resumen.minutos_utilizados);

      // 6. Calcular llamadas de los últimos 7 días
      const llamadasUltimos7Dias = this.calculateLast7Days(calls);

      return {
        resumen,
        agentes,
        llamadas_ultimos_7_dias: llamadasUltimos7Dias,
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
   * Calcula el resumen de métricas
   */
  private calculateSummary(calls: TwilioCall[]): SummaryDto {
    const totalLlamadas = calls.length;

    // Calcular total de segundos primero
    const totalSegundos = calls.reduce((total, call) => {
      const durationSegundos = parseInt(call.duration || '0', 10);
      return total + durationSegundos;
    }, 0);

    // Convertir segundos a minutos
    const minutosUtilizados = Math.round(totalSegundos / 60);

    console.log(
      `[Metrics] Total de segundos de llamadas: ${totalSegundos} segundos (${minutosUtilizados} minutos)`,
    );

    // Tiempo ahorrado = minutos utilizados × factor de ahorro
    const tiempoAhorrado = Math.round(
      minutosUtilizados * this.TIEMPO_AHORRO_FACTOR,
    );

    return {
      total_llamadas: totalLlamadas,
      tiempo_ahorrado: tiempoAhorrado,
      minutos_utilizados: minutosUtilizados,
    };
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
  private calculateLast7Days(calls: TwilioCall[]): LlamadaPorDiaDto[] {
    // Obtener los últimos 7 días
    const ultimos7Dias: LlamadaPorDiaDto[] = [];
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
      const { startDate: startDate7Days, endDate: endDate7Days } =
        this.getLast7DaysRange();
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
      const evaluacionExito =
        this.calculateEvaluacionExito(allCallsForAnalysis);
      const razonesFinalizacion =
        this.calculateRazonesFinalizacion(allCallsForAnalysis);

      return {
        llamadasExitosasUltimos7Dias,
        resumenComparativoSemanal,
        totalMinutosUltimoMes,
        duracionMediaLlamadas,
        tiposLlamadas,
        paisesOrigen,
        evaluacionExito,
        razonesFinalizacion,
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
    if (!account) {
      throw new NotFoundException(
        `Cuenta de Twilio con ID ${twilioAccountId} no encontrada.`,
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

      const totalMinutes = inboundMinutes + outboundMinutes;
      console.log(
        `[Metrics] Minutos último mes - Inbound: ${inboundMinutes}, Outbound: ${outboundMinutes}, Total: ${totalMinutes}`,
      );

      return totalMinutes;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error(
        '[Metrics] Error obteniendo minutos del último mes:',
        errorMessage,
      );
      return 0;
    }
  }

  /**
   * Calcula la duración media de las llamadas en minutos
   */
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

    const inboundPercentage = Math.round((inboundCount / calls.length) * 100);
    const outboundPercentage = Math.round((outboundCount / calls.length) * 100);

    console.log(
      `[Metrics] Tipos llamadas - Inbound: ${inboundCount} (${inboundPercentage}%), Outbound: ${outboundCount} (${outboundPercentage}%)`,
    );

    return {
      inbound: inboundPercentage,
      outbound: outboundPercentage,
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

    // Caso 1: Formato internacional +34XXX
    if (cleanPhone.startsWith('+')) {
      // Extraer los siguientes 1-3 dígitos después del +
      const match = cleanPhone.match(/^\+(\d{1,3})/);
      return match ? match[1] : null;
    }

    // Caso 2: Formato sin + (ej: 34XXX, 0034XXX)
    if (cleanPhone.length >= 10) {
      // Para números largos, intentar extraer los primeros 1-3 dígitos como código de país
      // Códigos de país comunes: 1 (EE.UU.), 34 (España), 52 (México), 54 (Argentina), 55 (Brasil), etc.
      const firstThree = cleanPhone.substring(0, 3);
      const firstTwo = cleanPhone.substring(0, 2);
      const firstOne = cleanPhone.substring(0, 1);

      // Priorizar códigos de 3 dígitos (más específicos)
      if (this.isValidCountryCode(firstThree)) {
        return firstThree;
      }

      // Luego códigos de 2 dígitos
      if (this.isValidCountryCode(firstTwo)) {
        return firstTwo;
      }

      // Finalmente códigos de 1 dígito
      if (this.isValidCountryCode(firstOne)) {
        return firstOne;
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
  private calculateEvaluacionExito(calls: TwilioCall[]): EvaluacionExitoDto {
    if (calls.length === 0) {
      return { exitosas: 0, parciales: 0, fallidas: 0 };
    }

    // Exitosas: completed
    const exitosasCount = calls.filter(
      (call) => call.status === 'completed',
    ).length;

    // Parciales: answered, in-progress
    const parcialesCount = calls.filter(
      (call) => call.status === 'answered' || call.status === 'in-progress',
    ).length;

    // Fallidas: failed, busy, no-answer, canceled
    const fallidasCount = calls.filter((call) =>
      ['failed', 'busy', 'no-answer', 'canceled'].includes(call.status),
    ).length;

    const exitosasPercentage = Math.round((exitosasCount / calls.length) * 100);
    const parcialesPercentage = Math.round(
      (parcialesCount / calls.length) * 100,
    );
    const fallidasPercentage = Math.round((fallidasCount / calls.length) * 100);

    console.log(
      `[Metrics] Evaluación éxito - Exitosas: ${exitosasCount} (${exitosasPercentage}%), Parciales: ${parcialesCount} (${parcialesPercentage}%), Fallidas: ${fallidasCount} (${fallidasPercentage}%)`,
    );

    return {
      exitosas: exitosasPercentage,
      parciales: parcialesPercentage,
      fallidas: fallidasPercentage,
    };
  }

  /**
   * Calcula las razones de finalización de las llamadas
   */
  private calculateRazonesFinalizacion(
    calls: TwilioCall[],
  ): RazonesFinalizacionDto {
    if (calls.length === 0) {
      return {
        completada: 0,
        clienteColgo: 0,
        errorTecnico: 0,
        tiempoAgotado: 0,
      };
    }

    // Completada con éxito: completed
    const completadaCount = calls.filter(
      (call) => call.status === 'completed',
    ).length;

    // Cliente colgó: no-answer, canceled
    const clienteColgoCount = calls.filter(
      (call) => call.status === 'no-answer' || call.status === 'canceled',
    ).length;

    // Error técnico: failed
    const errorTecnicoCount = calls.filter(
      (call) => call.status === 'failed',
    ).length;

    // Tiempo agotado: busy (puede incluir timeout)
    const tiempoAgotadoCount = calls.filter(
      (call) => call.status === 'busy',
    ).length;

    const completadaPercentage = Math.round(
      (completadaCount / calls.length) * 100,
    );
    const clienteColgoPercentage = Math.round(
      (clienteColgoCount / calls.length) * 100,
    );
    const errorTecnicoPercentage = Math.round(
      (errorTecnicoCount / calls.length) * 100,
    );
    const tiempoAgotadoPercentage = Math.round(
      (tiempoAgotadoCount / calls.length) * 100,
    );

    console.log(
      `[Metrics] Razones finalización - Completada: ${completadaCount} (${completadaPercentage}%), Cliente colgó: ${clienteColgoCount} (${clienteColgoPercentage}%), Error técnico: ${errorTecnicoCount} (${errorTecnicoPercentage}%), Tiempo agotado: ${tiempoAgotadoCount} (${tiempoAgotadoPercentage}%)`,
    );

    return {
      completada: completadaPercentage,
      clienteColgo: clienteColgoPercentage,
      errorTecnico: errorTecnicoPercentage,
      tiempoAgotado: tiempoAgotadoPercentage,
    };
  }
}
