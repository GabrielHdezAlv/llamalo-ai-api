import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { getFirestore } from '../firebase/firebase.config';
import { PeriodFilter } from './dto/dashboard-query.dto';
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
   */
  async getDashboardMetrics(
    userId: string,
    period: PeriodFilter = PeriodFilter.WEEK,
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

      // 2. Calcular fechas según el período
      const { startDate, endDate } = this.getDateRange(period);

      // 3. Obtener todas las llamadas del período desde Twilio
      const calls = await this.fetchTwilioCalls(sid, token, startDate, endDate);

      // 4. Calcular resumen
      const resumen = this.calculateSummary(calls);

      // 5. Obtener agentes
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
   * Obtiene el rango de fechas según el período seleccionado
   */
  private getDateRange(period: PeriodFilter): {
    startDate: Date;
    endDate: Date;
  } {
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999); // Fin del día actual

    const startDate = new Date();

    switch (period) {
      case PeriodFilter.DAY:
        startDate.setHours(0, 0, 0, 0);
        break;
      case PeriodFilter.WEEK:
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        break;
      case PeriodFilter.MONTH:
        startDate.setMonth(startDate.getMonth() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      case PeriodFilter.SIX_MONTHS:
        startDate.setMonth(startDate.getMonth() - 6);
        startDate.setHours(0, 0, 0, 0);
        break;
      case PeriodFilter.YEAR:
        startDate.setFullYear(startDate.getFullYear() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
    }

    return { startDate, endDate };
  }

  /**
   * Obtiene todas las llamadas de Twilio en el rango de fechas
   */
  private async fetchTwilioCalls(
    sid: string,
    token: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TwilioCall[]> {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const allCalls: TwilioCall[] = [];
    let nextPageUri: string | null = null;

    // Formatear fechas para Twilio API usando DateCreated
    // Twilio espera formato YYYY-MM-DD o YYYY-MM-DD HH:MM:SS
    // Usamos formato con hora para asegurar precisión, especialmente para el día actual
    const formatDateForTwilio = (date: Date): string => {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hours = String(date.getUTCHours()).padStart(2, '0');
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      const seconds = String(date.getUTCSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    const startDateStr = formatDateForTwilio(startDate);
    const endDateStr = formatDateForTwilio(endDate);

    do {
      const url: string =
        nextPageUri ||
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?DateCreated>=${encodeURIComponent(startDateStr)}&DateCreated<=${encodeURIComponent(endDateStr)}&PageSize=1000`;

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
        // Si falla, retornar las llamadas que se hayan obtenido hasta ahora
        console.error('Error obteniendo llamadas de Twilio:', error);
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

    for (let i = 6; i >= 0; i--) {
      const fecha = new Date(hoy);
      fecha.setDate(fecha.getDate() - i);
      fecha.setHours(0, 0, 0, 0);

      // Obtener fecha en formato YYYY-MM-DD (usando UTC para consistencia)
      const year = fecha.getUTCFullYear();
      const month = String(fecha.getUTCMonth() + 1).padStart(2, '0');
      const day = String(fecha.getUTCDate()).padStart(2, '0');
      const fechaStr = `${year}-${month}-${day}`;

      // Contar llamadas de ese día
      // Las fechas de Twilio vienen en UTC, así que comparamos en UTC
      const llamadasDelDia = calls.filter((call) => {
        if (!call.dateCreated) return false;
        const callDate = new Date(call.dateCreated);
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

    return ultimos7Dias;
  }
}
