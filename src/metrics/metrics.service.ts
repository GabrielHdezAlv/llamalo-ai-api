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
      const twilioConfig = userData?.twilio as Record<string, unknown>;

      if (!twilioConfig) {
        throw new NotFoundException(
          'Configuración de Twilio no encontrada para el usuario.',
        );
      }

      const sid = twilioConfig.twilioSid as string;
      const token = twilioConfig.twilioToken as string;

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
}
