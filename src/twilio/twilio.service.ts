import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { TwilioConfigDto } from './dto/twilio-config.dto';
import { getFirestore } from '../firebase/firebase.config';

@Injectable()
export class TwilioService {
  private firestore = getFirestore();

  // 🔒 Verificar si twilioSid o twilioToken están en uso por otro usuario
  private async checkTwilioCredentialsInUse(
    userId: string,
    twilioSid: string,
    twilioToken: string,
  ): Promise<void> {
    // Obtener todos los usuarios
    const allUsersSnapshot = await this.firestore.collection('users').get();

    for (const userDoc of allUsersSnapshot.docs) {
      // Ignorar el usuario actual
      if (userDoc.id === userId) {
        continue;
      }

      const userData = userDoc.data() as Record<string, unknown>;
      const userTwilioConfig = (userData?.twilio as Record<string, unknown>) || {};

      const existingSid = userTwilioConfig.twilioSid as string | undefined;
      const existingToken = userTwilioConfig.twilioToken as string | undefined;

      // Verificar si alguno de los dos parámetros está en uso
      if (existingSid === twilioSid || existingToken === twilioToken) {
        throw new BadRequestException(
          'Error: No se han podido asignar estos datos de configuración de Twilio, para más información contacte con nuestro equipo de soporte',
        );
      }
    }
  }

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

      // Validar que los parámetros no estén en uso por otro usuario
      await this.checkTwilioCredentialsInUse(
        userId,
        config.twilioSid,
        config.twilioToken,
      );

      let hasChanges = false;

      // Nueva estructura: twilio solo contiene twilioSid y twilioToken
      // Los otros campos (countryCode, phoneNumber, firstInteraction, agentInstruction)
      // deberían ir en phoneNumbers[] y agents[] respectivamente
      const newTwilioConfig: { twilioSid: string; twilioToken: string } = {
        twilioSid: config.twilioSid,
        twilioToken: config.twilioToken,
      };

      // Si no existe o hay cambios en SID/Token, actualizar
      if (!twilioConfig) {
        hasChanges = true;
      } else {
        if (
          (twilioConfig.twilioSid as string) !== config.twilioSid ||
          (twilioConfig.twilioToken as string) !== config.twilioToken
        ) {
          hasChanges = true;
        }
      }

      // Si hay cambios en twilio, actualizar
      if (hasChanges) {
        await userDocRef.set({ twilio: newTwilioConfig }, { merge: true });
        
        // TODO: Migrar countryCode y phoneNumber a phoneNumbers[]
        // TODO: Migrar firstInteraction y agentInstruction a agents[]
        // Por ahora mantenemos compatibilidad pero estos campos ya no se guardan en twilio
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

  // ✅ Obtener configuración de Twilio con minutos consumidos
  async getTwilioInfo(userId: string) {
    try {
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

      // Obtener minutos consumidos
      let inboundMinutes = {};
      try {
        const sid = twilioConfig.twilioSid as string;
        const token = twilioConfig.twilioToken as string;

        if (sid && token) {
          const auth = Buffer.from(`${sid}:${token}`).toString('base64');
          const response = await axios.get<{
            usage_records: Array<{
              category: string;
              usage: string;
              usage_unit: string;
            }>;
          }>(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json`,
            {
              headers: {
                Authorization: `Basic ${auth}`,
              },
            },
          );

          const usageRecords = response.data.usage_records;
          const inbound = usageRecords.find(
            (record) => record.category === 'calls-inbound',
          );

          if (inbound) {
            inboundMinutes = {
              minutes: inbound.usage,
              unit: inbound.usage_unit,
            };
          } else {
            inboundMinutes = {
              minutes: '0',
              message: 'No hay consumo de llamadas entrantes registrado.',
            };
          }
        }
      } catch {
        // Si falla la obtención de minutos, continuar sin ellos
        inboundMinutes = {
          minutes: '0',
          message: 'No se pudieron obtener los minutos consumidos.',
        };
      }

      // Devolver solo los campos que el frontend espera
      return {
        twilioSid: twilioConfig.twilioSid as string,
        twilioToken: twilioConfig.twilioToken as string,
        inboundMinutes,
      };
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
    } catch {
      return false;
    }
  }

  // ✅ Verificar si un número de teléfono está en la cuenta de Twilio del usuario
  async validatePhoneNumber(userId: string, phoneNumber: string) {
    try {
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
          'Credenciales de Twilio no configuradas correctamente.',
        );
      }

      // Normalizar el número de teléfono (eliminar espacios, guiones, etc.)
      const normalizedPhone = phoneNumber.replace(/\s|-|\(|\)/g, '');

      // Obtener todos los números de teléfono de la cuenta de Twilio
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      let allPhoneNumbers: string[] = [];
      let nextPageUri: string | null = null;

      do {
        const url = nextPageUri
          ? `https://api.twilio.com${nextPageUri}`
          : `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;

        const response = await axios.get<{
          incoming_phone_numbers: Array<{
            phone_number: string;
          }>;
          next_page_uri: string | null;
        }>(url, {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        });

        const phoneNumbers = response.data.incoming_phone_numbers.map(
          (phone) => phone.phone_number.replace(/\s|-|\(|\)/g, ''),
        );
        allPhoneNumbers = allPhoneNumbers.concat(phoneNumbers);
        nextPageUri = response.data.next_page_uri;
      } while (nextPageUri);

      // Verificar si el número está en la lista
      const isNumberFound = allPhoneNumbers.some(
        (twilioPhone) => twilioPhone === normalizedPhone,
      );

      if (!isNumberFound) {
        throw new BadRequestException('Número no disponible');
      }

      // Extraer código de país y número del formato E.164 (+34...)
      const phoneMatch = normalizedPhone.match(/^\+(\d{1,3})(.+)$/);
      if (!phoneMatch) {
        throw new BadRequestException(
          'Formato de número de teléfono inválido. Use formato E.164 (ej: +34654316415)',
        );
      }

      const countryCode = `+${phoneMatch[1]}`;
      const numberWithoutCountryCode = phoneMatch[2];

      // Obtener phoneNumbers actuales del usuario
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Verificar si el número ya existe en phoneNumbers
      const numberExists = phoneNumbersArray.some((phone) => {
        const existingNumber = (phone.number as string)?.replace(/\D/g, '') || '';
        const existingCountryCode = phone.countryCode as string;
        return (
          existingNumber === numberWithoutCountryCode &&
          existingCountryCode === countryCode
        );
      });

      // Si no existe, añadirlo
      if (!numberExists) {
        const phoneId = Date.now();
        phoneNumbersArray.push({
          phoneId: phoneId,
          countryCode: countryCode,
          number: numberWithoutCountryCode,
          state: 'Inactivo', // Inactivo porque no está siendo usado por ningún agente aún
          importedBy: 'Twilio',
        });

        // Actualizar phoneNumbers en Firestore
        await userDocRef.update({
          phoneNumbers: phoneNumbersArray,
        });
      }

      return {
        message: 'Número verificado correctamente',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al validar el número de teléfono: ${(error as Error).message}`,
      );
    }
  }
}
