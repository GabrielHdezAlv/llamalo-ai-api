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
  dateCreated: string;
  startTime: string;
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

      // Log para debugging - fechas calculadas
      console.log(
        `[Metrics] Obteniendo métricas de los últimos 7 días - Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`,
      );

      // 3. Obtener todas las llamadas de los últimos 7 días desde Twilio
      const calls = await this.fetchTwilioCalls(sid, token, startDate, endDate);

      // Log para debugging
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

    // StartDate: inicio del día hace 7 días (00:00:00.000)
    const weekAgo = new Date(now);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
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
      console.log(
        `[Metrics] Rango grande (${diffDays} días), dividiendo en múltiples consultas...`,
      );
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

      console.log(
        `[Metrics] Consultando chunk: ${currentStart.toISOString()} hasta ${currentEnd.toISOString()}`,
      );

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

    // Log para debugging
    console.log(
      `[Metrics] Consultando Twilio - desde ${startDateStr} hasta ${endDateStr}`,
    );

    do {
      const url: string =
        nextPageUri ||
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?StartTime>=${encodeURIComponent(startDateStr)}&StartTime<=${encodeURIComponent(endDateStr)}&Direction=inbound&PageSize=1000`;

      // Log de la URL solo en la primera petición
      if (!nextPageUri) {
        console.log(`[Metrics] URL de Twilio: ${url}`);
      }

      try {
        const response = await axios.get<TwilioCallsResponse>(url, {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        });

        const calls = response.data.calls;
        if (calls && Array.isArray(calls)) {
          allCalls.push(...calls);
          console.log(
            `[Metrics] Página obtenida: ${calls.length} llamadas (Total acumulado: ${allCalls.length})`,
          );
          // Log de las primeras llamadas para verificar los datos
          if (allCalls.length === calls.length && calls.length > 0) {
            console.log(
              `[Metrics] Ejemplo de llamada recibida:`,
              JSON.stringify(
                {
                  sid: calls[0].sid,
                  startTime: calls[0].startTime,
                  dateCreated: calls[0].dateCreated,
                  duration: calls[0].duration,
                },
                null,
                2,
              ),
            );
          }
        }

        nextPageUri = response.data.next_page_uri || null;
        if (nextPageUri) {
          console.log(`[Metrics] Hay más páginas, continuando...`);
        }
      } catch (error) {
        // Log detallado del error
        if (axios.isAxiosError(error)) {
          console.error(
            `[Metrics] Error de Twilio API:`,
            error.response?.status,
            error.response?.statusText,
          );
          console.error(
            `[Metrics] Respuesta de error:`,
            JSON.stringify(error.response?.data, null, 2),
          );
        } else {
          console.error(
            '[Metrics] Error obteniendo llamadas de Twilio:',
            error,
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
    const minutosUtilizados = calls.reduce((total, call) => {
      const duration = parseInt(call.duration || '0', 10);
      return total + duration;
    }, 0);

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

    // Log para debugging
    console.log(
      `[Metrics] Calculando llamadas de los últimos 7 días. Total de llamadas recibidas: ${calls.length}`,
    );

    // Log de resumen de fechas de las llamadas recibidas
    if (calls.length > 0) {
      const fechasUnicas = new Set<string>();
      calls.forEach((call) => {
        if (call.startTime) {
          const callDate = new Date(call.startTime);
          const fechaStr = `${callDate.getUTCFullYear()}-${String(callDate.getUTCMonth() + 1).padStart(2, '0')}-${String(callDate.getUTCDate()).padStart(2, '0')}`;
          fechasUnicas.add(fechaStr);
        }
      });
      console.log(
        `[Metrics] Fechas únicas encontradas en las llamadas:`,
        Array.from(fechasUnicas).sort().join(', '),
      );
    }

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
      // Usar startTime en lugar de dateCreated para agrupar por el día en que realmente comenzó la llamada
      // Las fechas de Twilio vienen en UTC, así que comparamos en UTC
      const llamadasDelDia = calls.filter((call) => {
        if (!call.startTime) {
          console.warn(`[Metrics] Llamada sin startTime: ${call.sid}`);
          return false;
        }
        const callDate = new Date(call.startTime);
        const callYear = callDate.getUTCFullYear();
        const callMonth = String(callDate.getUTCMonth() + 1).padStart(2, '0');
        const callDay = String(callDate.getUTCDate()).padStart(2, '0');
        const callDateStr = `${callYear}-${callMonth}-${callDay}`;
        return callDateStr === fechaStr;
      });

      console.log(
        `[Metrics] Día ${fechaStr}: ${llamadasDelDia.length} llamadas`,
      );

      ultimos7Dias.push({
        fecha: fechaStr,
        total: llamadasDelDia.length,
      });
    }

    return ultimos7Dias;
  }
}
