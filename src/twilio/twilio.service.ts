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

  // 🔧 Normalizar twilio: convierte estructura antigua (objeto) a nueva (array)
  private normalizeTwilioArray(
    twilioData: unknown,
  ): Array<{
    twilioAccountId: number;
    twilioSid: string;
    twilioToken: string;
  }> {
    // Si es undefined o null, retornar array vacío
    if (!twilioData) {
      return [];
    }

    // Si ya es un array, retornar
    if (Array.isArray(twilioData)) {
      return twilioData as Array<{
        twilioAccountId: number;
        twilioSid: string;
        twilioToken: string;
      }>;
    }

    // Si es un objeto (estructura antigua), convertir a array
    if (typeof twilioData === 'object' && twilioData !== null) {
      const oldTwilio = twilioData as Record<string, unknown>;
      if (oldTwilio.twilioSid && oldTwilio.twilioToken) {
        // Convertir estructura antigua a nueva
        return [
          {
            twilioAccountId: 1,
            twilioSid: oldTwilio.twilioSid as string,
            twilioToken: oldTwilio.twilioToken as string,
          },
        ];
      }
    }

    // Si no es ni array ni objeto válido, retornar array vacío
    return [];
  }

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
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      const isInUse = twilioArray.some(
        (account) => account.twilioSid === twilioSid || account.twilioToken === twilioToken
      );

      if (isInUse) {
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
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      // Validar que los parámetros no estén en uso por otro usuario
      await this.checkTwilioCredentialsInUse(
        userId,
        config.twilioSid,
        config.twilioToken,
      );

      // Validar credenciales antes de guardar
      const isValid = await this.validateTwilioCredentials(
        config.twilioSid,
        config.twilioToken,
      );
      if (!isValid) {
        throw new BadRequestException(
          'Las credenciales de Twilio son inválidas.',
        );
      }

      // Si se proporciona twilioAccountId, actualizar esa cuenta
      if (config.twilioAccountId !== undefined) {
        const accountIndex = twilioArray.findIndex(
          (acc) => acc.twilioAccountId === config.twilioAccountId
        );

        if (accountIndex === -1) {
          throw new NotFoundException(
            `Cuenta de Twilio con ID ${config.twilioAccountId} no encontrada.`,
          );
        }

        // Verificar que las nuevas credenciales no estén en uso por otra cuenta del mismo usuario
        const otherAccount = twilioArray.find(
          (acc, idx) => 
            idx !== accountIndex && 
            (acc.twilioSid === config.twilioSid || acc.twilioToken === config.twilioToken)
        );

        if (otherAccount) {
          throw new BadRequestException(
            'Estas credenciales ya están asociadas a otra cuenta de Twilio en tu perfil.',
          );
        }

        // Actualizar cuenta existente
        twilioArray[accountIndex] = {
          twilioAccountId: config.twilioAccountId,
          twilioSid: config.twilioSid,
          twilioToken: config.twilioToken,
        };
      } else {
        // Crear nueva cuenta (generar ID único)
        const maxId = twilioArray.length > 0
          ? Math.max(...twilioArray.map(acc => acc.twilioAccountId))
          : 0;
        const newAccountId = maxId + 1;

        // Verificar que las credenciales no estén en uso por otra cuenta del mismo usuario
        const existingAccount = twilioArray.find(
          (acc) => acc.twilioSid === config.twilioSid || acc.twilioToken === config.twilioToken
        );

        if (existingAccount) {
          throw new BadRequestException(
            'Estas credenciales ya están asociadas a otra cuenta de Twilio en tu perfil.',
          );
        }

        twilioArray.push({
          twilioAccountId: newAccountId,
          twilioSid: config.twilioSid,
          twilioToken: config.twilioToken,
        });
      }

      await userDocRef.set({ twilio: twilioArray }, { merge: true });

      return {
        message: 'Configuración de Twilio actualizada correctamente.',
      };
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
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      if (twilioArray.length === 0) {
        throw new NotFoundException(
          'Configuración de Twilio no encontrada para el usuario.',
        );
      }

      // Obtener minutos consumidos para todas las cuentas
      const accountsWithMinutes = await Promise.all(
        twilioArray.map(async (account) => {
          let inboundMinutes = {};
          try {
            const auth = Buffer.from(`${account.twilioSid}:${account.twilioToken}`).toString('base64');
            const response = await axios.get<{
              usage_records: Array<{
                category: string;
                usage: string;
                usage_unit: string;
              }>;
            }>(
              `https://api.twilio.com/2010-04-01/Accounts/${account.twilioSid}/Usage/Records/ThisMonth.json`,
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
          } catch {
            inboundMinutes = {
              minutes: '0',
              message: 'No se pudieron obtener los minutos consumidos.',
            };
          }

          return {
            twilioAccountId: account.twilioAccountId,
            twilioSid: account.twilioSid,
            twilioToken: account.twilioToken,
            inboundMinutes,
          };
        })
      );

      return {
        accounts: accountsWithMinutes,
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

  // Helper para calcular el estado de un phoneNumber basado en si algún agente lo usa
  private calculatePhoneNumberState(
    phoneId: number,
    agents: Array<Record<string, unknown>>,
  ): 'Activo' | 'Inactivo' {
    if (!agents || agents.length === 0) {
      return 'Inactivo';
    }
    const isUsed = agents.some((agent) => {
      const agentPhone = agent.phoneNumbers as
        | Record<string, unknown>
        | undefined;
      return agentPhone && (agentPhone.phoneId as number) === phoneId;
    });
    return isUsed ? 'Activo' : 'Inactivo';
  }

  // Helper para actualizar el estado de todos los phoneNumbers
  private updatePhoneNumbersState(
    phoneNumbersArray: Array<Record<string, unknown>>,
    agentsArray: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return phoneNumbersArray.map((phone) => ({
      ...phone,
      state: this.calculatePhoneNumberState(
        phone.phoneId as number,
        agentsArray,
      ),
      importedBy: phone.importedBy || 'Twilio',
    }));
  }

  // ✅ Eliminar número de teléfono
  async deletePhoneNumber(userId: string, phoneId: number) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      // Buscar el número de teléfono en el array
      const phoneIndex = phoneNumbersArray.findIndex(
        (phone) => (phone.phoneId as number) === phoneId,
      );

      if (phoneIndex === -1) {
        throw new NotFoundException(
          `Número de teléfono con phoneId ${phoneId} no encontrado.`,
        );
      }

      // Buscar agentes que usen este phoneId
      const affectedAgents: number[] = [];
      const updatedAgents = agentsArray.map((agent) => {
        const agentPhone = agent.phoneNumbers as
          | Record<string, unknown>
          | undefined;
        const agentPhoneId = agentPhone?.phoneId as number | undefined;

        if (agentPhoneId === phoneId) {
          affectedAgents.push(agent.agentId as number);
          // Eliminar phoneNumbers del agente y poner estado a "Inactivo"
          const { phoneNumbers, ...agentWithoutPhone } = agent;
          return {
            ...agentWithoutPhone,
            state: 'Inactivo',
          };
        }
        return agent;
      });

      // Eliminar el número del array phoneNumbers
      phoneNumbersArray.splice(phoneIndex, 1);

      // Actualizar el estado de todos los phoneNumbers restantes basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        updatedAgents,
      );

      // Guardar en Firestore
      await userDocRef.set(
        {
          agents: updatedAgents,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Número de teléfono eliminado correctamente.',
        affectedAgents: affectedAgents.length,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al eliminar el número de teléfono: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Verificar si un número de teléfono está en la cuenta de Twilio del usuario
  async validatePhoneNumber(
    userId: string,
    countryCode: string,
    number: string,
    twilioAccountId?: number,
  ) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      if (twilioArray.length === 0) {
        throw new NotFoundException(
          'Configuración de Twilio no encontrada para el usuario.',
        );
      }

      // Si se proporciona twilioAccountId, usar esa cuenta
      let twilioConfig: { twilioAccountId: number; twilioSid: string; twilioToken: string };
      
      if (twilioAccountId !== undefined) {
        const account = twilioArray.find(
          (acc) => acc.twilioAccountId === twilioAccountId
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
          'Credenciales de Twilio no configuradas correctamente.',
        );
      }

      // Normalizar el prefijo del país (asegurar que empiece con +)
      const normalizedCountryCode = countryCode.startsWith('+')
        ? countryCode
        : `+${countryCode}`;

      // Normalizar el número (eliminar espacios, guiones, etc.)
      const normalizedNumber = number.replace(/\s|-|\(|\)/g, '');

      // Construir el número completo en formato E.164
      const normalizedPhone = `${normalizedCountryCode}${normalizedNumber}`;

      // Obtener todos los números de teléfono de la cuenta de Twilio
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      let allPhoneNumbers: string[] = [];
      let nextPageUri: string | null = null;

      do {
        const url: string = nextPageUri
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

        const phoneNumbers = response.data.incoming_phone_numbers.map((phone) =>
          phone.phone_number.replace(/\s|-|\(|\)/g, ''),
        );
        allPhoneNumbers = [...allPhoneNumbers, ...phoneNumbers];
        nextPageUri = response.data.next_page_uri;
      } while (nextPageUri);

      // Verificar si el número está en la lista
      const isNumberFound = allPhoneNumbers.some(
        (twilioPhone) => twilioPhone === normalizedPhone,
      );

      if (!isNumberFound) {
        throw new BadRequestException('Número no disponible');
      }

      // Usar los valores ya normalizados que recibimos como parámetros
      const finalCountryCode = normalizedCountryCode;
      const numberWithoutCountryCode = normalizedNumber;

      // Validar que el número no esté en uso por otro agente
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const numberInUse = agentsArray.some((agent) => {
        const agentPhone =
          (agent.phoneNumbers as Record<string, unknown> | undefined) ||
          undefined;
        if (!agentPhone) return false;

        // Normalizar números para comparación (eliminar caracteres no numéricos)
        const agentCountryCode = (agentPhone.countryCode as string) || '';
        const agentNumberValue = agentPhone.number;
        const agentNumber =
          typeof agentNumberValue === 'string' ||
          typeof agentNumberValue === 'number'
            ? String(agentNumberValue).replace(/\D/g, '')
            : '';
        const normalizedNewNumber = numberWithoutCountryCode.replace(/\D/g, '');

        return (
          agentCountryCode === finalCountryCode &&
          agentNumber === normalizedNewNumber
        );
      });

      if (numberInUse) {
        throw new BadRequestException(
          `El número de teléfono ${finalCountryCode} ${numberWithoutCountryCode} ya está en uso por otro agente.`,
        );
      }

      // Obtener phoneNumbers actuales del usuario
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Verificar si el número ya existe en phoneNumbers
      const numberExists = phoneNumbersArray.some((phone) => {
        const existingNumber =
          (phone.number as string)?.replace(/\D/g, '') || '';
        const existingCountryCode = phone.countryCode as string;
        return (
          existingNumber === numberWithoutCountryCode &&
          existingCountryCode === finalCountryCode
        );
      });

      // Si no existe, añadirlo
      if (!numberExists) {
        const phoneId = Date.now();
        phoneNumbersArray.push({
          phoneId: phoneId,
          countryCode: finalCountryCode,
          number: numberWithoutCountryCode,
          state: 'Inactivo', // Inactivo porque no está siendo usado por ningún agente aún
          importedBy: 'Twilio',
          twilioAccountId: twilioConfig.twilioAccountId,
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

  // ✅ Crear número de teléfono con validación de credenciales
  async createPhoneNumber(
    userId: string,
    countryCode: string,
    number: string,
    twilioSid: string,
    twilioToken: string,
  ) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      // 1. Validar que el SID y Token son correctos
      const isValidCredentials = await this.validateTwilioCredentials(
        twilioSid,
        twilioToken,
      );
      if (!isValidCredentials) {
        throw new BadRequestException(
          'Las credenciales de Twilio (SID y Token) son inválidas.',
        );
      }

      // 2. Buscar la cuenta de Twilio que corresponde a estas credenciales
      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      const matchingAccount = twilioArray.find(
        (acc) => acc.twilioSid === twilioSid && acc.twilioToken === twilioToken
      );

      if (!matchingAccount) {
        throw new BadRequestException(
          'Las credenciales de Twilio proporcionadas no están configuradas en tu cuenta.',
        );
      }

      // 3. Validar que el número de teléfono existe en esa cuenta de Twilio
      const normalizedCountryCode = countryCode.startsWith('+')
        ? countryCode
        : `+${countryCode}`;

      const normalizedNumber = number.replace(/\s|-|\(|\)/g, '');
      const normalizedPhone = `${normalizedCountryCode}${normalizedNumber}`;

      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      let allPhoneNumbers: string[] = [];
      let nextPageUri: string | null = null;

      do {
        const url: string = nextPageUri
          ? `https://api.twilio.com${nextPageUri}`
          : `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json`;

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

        const phoneNumbers = response.data.incoming_phone_numbers.map((phone) =>
          phone.phone_number.replace(/\s|-|\(|\)/g, ''),
        );
        allPhoneNumbers = [...allPhoneNumbers, ...phoneNumbers];
        nextPageUri = response.data.next_page_uri;
      } while (nextPageUri);

      const isNumberFound = allPhoneNumbers.some(
        (twilioPhone) => twilioPhone === normalizedPhone,
      );

      if (!isNumberFound) {
        throw new BadRequestException(
          'El número de teléfono no existe en la cuenta de Twilio proporcionada.',
        );
      }

      // 4. Verificar que ese número de teléfono no esté ya en los números del usuario
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      const numberExists = phoneNumbersArray.some((phone) => {
        const existingNumber =
          (phone.number as string)?.replace(/\D/g, '') || '';
        const existingCountryCode = phone.countryCode as string;
        return (
          existingNumber === normalizedNumber &&
          existingCountryCode === normalizedCountryCode
        );
      });

      if (numberExists) {
        throw new BadRequestException(
          'Este número de teléfono ya está registrado en tu cuenta.',
        );
      }

      // 5. Agregar el número de teléfono a los números del usuario
      const phoneId = Date.now();
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      phoneNumbersArray.push({
        phoneId: phoneId,
        countryCode: normalizedCountryCode,
        number: normalizedNumber,
        state: 'Inactivo', // Inactivo porque no está siendo usado por ningún agente aún
        importedBy: 'Twilio',
        twilioAccountId: matchingAccount.twilioAccountId,
      });

      // Actualizar el estado de todos los phoneNumbers basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar en Firestore
      await userDocRef.set(
        {
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Número de teléfono añadido correctamente',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al crear el número de teléfono: ${(error as Error).message}`,
      );
    }
  }
}
