import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { TwilioConfigDto } from './dto/twilio-config.dto';

@Injectable()
export class TwilioService {
  private firestore = admin.firestore();

  // ✅ Configurar Twilio
  async setTwilioConfig(userId: string, config: TwilioConfigDto) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      let twilioConfig = (userData?.twilio as Record<string, unknown>) || null;

      let hasChanges = false;

      // Si no existe, crear nueva configuración
      if (!twilioConfig) {
        twilioConfig = {
          countryCode: config.countryCode,
          phoneNumber: config.phoneNumber,
          twilioSid: config.twilioSid,
          twilioToken: config.twilioToken,
          firstInteraction: config.firstInteraction,
          firstInteractionUrl: config.firstInteractionUrl,
          agentInstruction: config.agentInstruction,
        };
        hasChanges = true;
      } else {
        // Verificar cambios
        if (twilioConfig.countryCode !== config.countryCode) {
          twilioConfig.countryCode = config.countryCode;
          hasChanges = true;
        }
        if (twilioConfig.phoneNumber !== config.phoneNumber) {
          twilioConfig.phoneNumber = config.phoneNumber;
          hasChanges = true;
        }
        if (twilioConfig.twilioSid !== config.twilioSid) {
          twilioConfig.twilioSid = config.twilioSid;
          hasChanges = true;
        }
        if (twilioConfig.twilioToken !== config.twilioToken) {
          twilioConfig.twilioToken = config.twilioToken;
          hasChanges = true;
        }
        if (twilioConfig.firstInteraction !== config.firstInteraction) {
          twilioConfig.firstInteraction = config.firstInteraction;
          hasChanges = true;
        }
        if (twilioConfig.firstInteractionUrl !== config.firstInteractionUrl) {
          twilioConfig.firstInteractionUrl = config.firstInteractionUrl;
          hasChanges = true;
        }
        if (twilioConfig.agentInstruction !== config.agentInstruction) {
          twilioConfig.agentInstruction = config.agentInstruction;
          hasChanges = true;
        }
      }

      // Si hay cambios, actualizar
      if (hasChanges) {
        await userDocRef.set({ twilio: twilioConfig }, { merge: true });
        return {
          message: 'Configuración de Twilio actualizada correctamente.',
        };
      } else {
        // No hay cambios, validar credenciales
        const isValid = await this.validateTwilioCredentials(
          config.twilioSid,
          config.twilioToken,
        );
        if (!isValid) {
          throw new BadRequestException(
            'Las credenciales de Twilio son inválidas.',
          );
        }
        return {
          message:
            'No hubo cambios en la configuración de Twilio, pero las credenciales son válidas.',
        };
      }
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al procesar la configuración de Twilio: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Obtener configuración de Twilio
  async getTwilioInfo(userId: string) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioConfig = userData?.twilio;

      if (!twilioConfig) {
        throw new NotFoundException(
          'Configuración de Twilio no encontrada para el usuario.',
        );
      }

      return twilioConfig;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener la configuración de Twilio: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Obtener minutos de llamadas entrantes
  async getInboundMinutes(userId: string) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioConfig = userData?.twilio as Record<string, unknown>;

      if (!twilioConfig) {
        throw new NotFoundException('Configuración de Twilio no encontrada.');
      }

      const sid = twilioConfig.twilioSid as string;
      const token = twilioConfig.twilioToken as string;

      if (!sid || !token) {
        throw new BadRequestException(
          'Credenciales de Twilio no configuradas correctamente.',
        );
      }

      // Autenticación básica
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');

      const response = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
      );

      const usageRecords = response.data.usage_records;
      const inbound = usageRecords.find(
        (record: { category: string }) => record.category === 'calls-inbound',
      );

      if (!inbound) {
        return {
          minutes: '0',
          message: 'No hay consumo de llamadas entrantes registrado.',
        };
      }

      return {
        minutes: inbound.usage,
        unit: inbound.usage_unit,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        throw new BadRequestException(
          'No se pudo obtener el consumo de minutos inbound desde Twilio.',
        );
      }
      throw new BadRequestException(
        `Error al obtener minutos de Twilio: ${(error as Error).message}`,
      );
    }
  }

  // 🔒 Validar credenciales de Twilio
  private async validateTwilioCredentials(
    sid: string,
    token: string,
  ): Promise<boolean> {
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const response = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
      );

      return response.status === 200;
    } catch (error) {
      return false;
    }
  }
}

