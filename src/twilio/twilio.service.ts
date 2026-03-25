import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { FieldValue } from 'firebase-admin/firestore';
import { TwilioConfigDto } from './dto/twilio-config.dto';
import { getFirestore } from '../firebase/firebase.config';

@Injectable()
export class TwilioService {
  private firestore = getFirestore();

  // 🔧 Normalizar twilio: convierte estructura antigua (objeto) a nueva (array)
  private normalizeTwilioArray(twilioData: unknown): Array<{
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
            twilioAccountId: Date.now(),
            twilioSid: oldTwilio.twilioSid as string,
            twilioToken: oldTwilio.twilioToken as string,
          },
        ];
      }
    }

    // Si no es ni array ni objeto válido, retornar array vacío
    return [];
  }

  // 🔒 Verificar si twilioSid está en uso por otro usuario usando el índice inverso (O(1))
  private async checkTwilioCredentialsInUse(
    userId: string,
    twilioSid: string,
    _twilioToken: string,
  ): Promise<void> {
    // Consultar el índice inverso en lugar de hacer full scan de users
    const indexDoc = await this.firestore
      .collection('twilio_index')
      .doc(twilioSid)
      .get();

    if (indexDoc.exists) {
      const ownerUserId = (indexDoc.data() as Record<string, string>)?.userId;
      // Si está en el índice y pertenece a otro usuario → credenciales en uso
      if (ownerUserId && ownerUserId !== userId) {
        throw new BadRequestException(
          'Error: No se han podido asignar estos datos de configuración de Twilio, para más información contacte con nuestro equipo de soporte',
        );
      }
    }
  }

  /**
   * Escribe o actualiza el índice inverso twilioSid → userId en Firestore.
   * Colección: twilio_index / {twilioSid} → { userId }
   * Permite al webhook encontrar el usuario en O(1) sin escanear toda la colección.
   */
  private async upsertTwilioIndex(userId: string, twilioSid: string): Promise<void> {
    try {
      await this.firestore
        .collection('twilio_index')
        .doc(twilioSid)
        .set({ userId, updatedAt: new Date().toISOString() }, { merge: true });
    } catch (err) {
      console.error(`[Twilio] Error actualizando twilio_index para ${twilioSid}:`, err);
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
          (acc) => acc.twilioAccountId === config.twilioAccountId,
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
            (acc.twilioSid === config.twilioSid ||
              acc.twilioToken === config.twilioToken),
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
        // Crear nueva cuenta (generar ID único usando timestamp)
        const newAccountId = Date.now();

        // Verificar que las credenciales no estén en uso por otra cuenta del mismo usuario
        const existingAccount = twilioArray.find(
          (acc) =>
            acc.twilioSid === config.twilioSid ||
            acc.twilioToken === config.twilioToken,
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

      // Actualizar índice inverso twilioSid → userId (permite al webhook encontrar el usuario en O(1))
      this.upsertTwilioIndex(userId, config.twilioSid).catch(
        (err) => console.error('[Twilio] Error actualizando twilio_index:', err),
      );

      // Registrar webhook automáticamente en todos los números de la cuenta
      // Se hace de forma no bloqueante para no retrasar la respuesta al usuario
      this.registerWebhookOnAllNumbers(config.twilioSid, config.twilioToken).catch(
        (err) => console.error('[Twilio] Error registrando webhook al conectar cuenta:', err),
      );

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
            const auth = Buffer.from(
              `${account.twilioSid}:${account.twilioToken}`,
            ).toString('base64');
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
        }),
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

  /**
   * URL del webhook de Twilio. Se lee de variable de entorno para flexibilidad
   * entre entornos (dev/staging/prod).
   */
  private get webhookUrl(): string {
    return process.env.BACKEND_URL
      ? `${process.env.BACKEND_URL}/metrics/twilio-webhook`
      : 'https://llamaloiabackend-5294.onrender.com/metrics/twilio-webhook';
  }

  /**
   * Registra el webhook de status callback en TODOS los números de una cuenta Twilio.
   * Se llama automáticamente al conectar una cuenta nueva.
   */
  async registerWebhookOnAllNumbers(twilioSid: string, twilioToken: string): Promise<void> {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

      // 1. Obtener todos los números con su SID
      let allNumbers: Array<{ sid: string; phoneNumber: string }> = [];
      let nextPageUri: string | null = null;

      do {
        const url: string = nextPageUri
          ? `https://api.twilio.com${nextPageUri}`
          : `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json`;

        const response = await axios.get<{
          incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
          next_page_uri: string | null;
        }>(url, { headers: { Authorization: `Basic ${auth}` } });

        allNumbers = [
          ...allNumbers,
          ...response.data.incoming_phone_numbers.map((p) => ({
            sid: p.sid,
            phoneNumber: p.phone_number,
          })),
        ];
        nextPageUri = response.data.next_page_uri;
      } while (nextPageUri);

      // 2. Actualizar cada número con el webhook de status callback
      await Promise.allSettled(
        allNumbers.map((number) =>
          this.registerWebhookOnNumber(twilioSid, twilioToken, number.sid),
        ),
      );

      console.log(
        `[Twilio] Webhook registrado en ${allNumbers.length} número(s) de la cuenta ${twilioSid}`,
      );
    } catch (err) {
      console.error('[Twilio] Error al registrar webhook en números:', err);
    }
  }

  /**
   * Registra el webhook de status callback en UN número específico (por su SID de Twilio).
   */
  private async registerWebhookOnNumber(
    twilioSid: string,
    twilioToken: string,
    phoneNumberSid: string,
  ): Promise<void> {
    const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const params = new URLSearchParams({
      StatusCallback: this.webhookUrl,
      StatusCallbackMethod: 'POST',
    });

    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
      params.toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
  }

  /**
   * Busca el SID de Twilio de un número de teléfono en formato E.164
   * y registra el webhook en él.
   */
  async registerWebhookOnPhoneNumber(
    twilioSid: string,
    twilioToken: string,
    phoneE164: string,
  ): Promise<void> {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      let phoneNumberSid: string | null = null;
      let nextPageUri: string | null = null;

      do {
        const url: string = nextPageUri
          ? `https://api.twilio.com${nextPageUri}`
          : `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json`;

        const response = await axios.get<{
          incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
          next_page_uri: string | null;
        }>(url, { headers: { Authorization: `Basic ${auth}` } });

        const found = response.data.incoming_phone_numbers.find(
          (p) => p.phone_number.replace(/\s|-/g, '') === phoneE164.replace(/\s|-/g, ''),
        );
        if (found) {
          phoneNumberSid = found.sid;
          break;
        }
        nextPageUri = response.data.next_page_uri;
      } while (nextPageUri);

      if (phoneNumberSid) {
        await this.registerWebhookOnNumber(twilioSid, twilioToken, phoneNumberSid);
        console.log(`[Twilio] Webhook registrado en número ${phoneE164}`);
      }
    } catch (err) {
      console.error(`[Twilio] Error al registrar webhook en ${phoneE164}:`, err);
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

      const removedPhoneRow = phoneNumbersArray[phoneIndex] as Record<
        string,
        unknown
      >;
      const removedDigits = parseInt(
        String(removedPhoneRow.number ?? '')
          .replace(/\D/g, '') || '0',
        10,
      );
      const twilioRaw = userData.twilio;
      const shouldStripLegacyTwilioPhoneNumber =
        twilioRaw &&
        typeof twilioRaw === 'object' &&
        !Array.isArray(twilioRaw) &&
        removedDigits !== 0;
      let legacyTwilioPhoneDigits: number | undefined;
      if (shouldStripLegacyTwilioPhoneNumber) {
        const legacyPn = (twilioRaw as Record<string, unknown>).phoneNumber;
        legacyTwilioPhoneDigits = parseInt(
          String(legacyPn ?? '')
            .replace(/\D/g, '') || '0',
          10,
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
          // Eliminar phoneNumbers y twilioAccountId del agente; estado Inactivo
          const { phoneNumbers, twilioAccountId: _tid, ...agentWithoutPhone } =
            agent;
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

      const payload: Record<string, unknown> = {
        agents: updatedAgents,
        phoneNumbers: updatedPhoneNumbers,
      };
      if (
        shouldStripLegacyTwilioPhoneNumber &&
        legacyTwilioPhoneDigits !== undefined &&
        legacyTwilioPhoneDigits === removedDigits
      ) {
        payload['twilio.phoneNumber'] = FieldValue.delete();
      }

      // Guardar en Firestore
      await userDocRef.set(payload, { merge: true });

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

        // Registrar webhook en este número automáticamente (fire-and-forget)
        this.registerWebhookOnPhoneNumber(
          twilioConfig.twilioSid,
          twilioConfig.twilioToken,
          normalizedPhone,
        ).catch((err) =>
          console.error('[Twilio] Error registrando webhook en nuevo número:', err),
        );
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

      let matchingAccount = twilioArray.find(
        (acc) => acc.twilioSid === twilioSid && acc.twilioToken === twilioToken,
      );

      let accountsUpdated = false;
      if (!matchingAccount) {
        // Verificar que las credenciales no estén en uso por otro usuario
        await this.checkTwilioCredentialsInUse(
          userId,
          twilioSid,
          twilioToken,
        );

        // Verificar que las credenciales no estén asociadas parcialmente a otra cuenta
        const existingAccount = twilioArray.find(
          (acc) =>
            acc.twilioSid === twilioSid ||
            acc.twilioToken === twilioToken,
        );

        if (existingAccount) {
          throw new BadRequestException(
            'Estas credenciales ya están asociadas a otra cuenta de Twilio en tu perfil.',
          );
        }

        // Si no existe, agregarla automáticamente a la cuenta del usuario
        const newAccountId = Date.now();
        matchingAccount = {
          twilioAccountId: newAccountId,
          twilioSid,
          twilioToken,
        };
        twilioArray.push(matchingAccount);
        accountsUpdated = true;

        // Actualizar índice inverso
        this.upsertTwilioIndex(userId, twilioSid).catch(
          (err) => console.error('[Twilio] Error actualizando twilio_index:', err),
        );

        // Registrar webhooks
        this.registerWebhookOnAllNumbers(twilioSid, twilioToken).catch(
          (err) => console.error('[Twilio] Error registrando webhook al conectar cuenta:', err),
        );
      }

      // 3. Validar que el número de teléfono existe en esa cuenta de Twilio
      const normalizedCountryCode = countryCode.startsWith('+')
        ? countryCode
        : `+${countryCode}`;

      const normalizedNumber = number.replace(/\s|-|\(|\)/g, '');
      const normalizedPhone = `${normalizedCountryCode}${normalizedNumber}`;

      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString(
        'base64',
      );
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
      const updateData: any = {
        phoneNumbers: updatedPhoneNumbers,
      };
      
      if (accountsUpdated) {
        updateData.twilio = twilioArray;
      }

      await userDocRef.set(updateData, { merge: true });

      // Registrar webhook en este número automáticamente (fire-and-forget)
      this.registerWebhookOnPhoneNumber(
        twilioSid,
        twilioToken,
        normalizedPhone,
      ).catch((err) =>
        console.error('[Twilio] Error registrando webhook en número creado:', err),
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

  // ✅ Eliminar cuenta(s) de Twilio (desvincular del usuario)
  async deleteTwilioAccount(userId: string, twilioAccountId?: number) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const twilioArray = this.normalizeTwilioArray(userData?.twilio);

      if (twilioArray.length === 0) {
        return {
          message: 'No hay cuentas de Twilio configuradas para eliminar.',
        };
      }

      let accountsToRemove: Array<{
        twilioAccountId: number;
        twilioSid: string;
        twilioToken: string;
      }> = [];
      let updatedTwilioArray: any[] = [];

      if (twilioAccountId !== undefined) {
        // Eliminar una cuenta específica
        const accountIndex = twilioArray.findIndex(
          (acc) => acc.twilioAccountId === twilioAccountId,
        );

        if (accountIndex === -1) {
          throw new NotFoundException(
            `Cuenta de Twilio con ID ${twilioAccountId} no encontrada.`,
          );
        }

        accountsToRemove = [twilioArray[accountIndex]];
        updatedTwilioArray = twilioArray.filter(
          (acc) => acc.twilioAccountId !== twilioAccountId,
        );
      } else {
        // Eliminar todas las cuentas
        accountsToRemove = twilioArray;
        updatedTwilioArray = [];
      }

      const removedTwilioAccountIds = new Set(
        accountsToRemove.map((a) => a.twilioAccountId),
      );

      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      const phoneIdsToRemove = new Set<number>();
      for (const phone of phoneNumbersArray) {
        const tid = phone.twilioAccountId as number | undefined;
        const pid = phone.phoneId as number | undefined;
        if (
          tid !== undefined &&
          pid !== undefined &&
          removedTwilioAccountIds.has(tid)
        ) {
          phoneIdsToRemove.add(pid);
        }
      }

      let updatedAgents = agentsArray;
      let updatedPhoneNumbers = phoneNumbersArray;

      if (phoneIdsToRemove.size > 0) {
        updatedAgents = agentsArray.map((agent) => {
          const agentPhone = agent.phoneNumbers as
            | Record<string, unknown>
            | undefined;
          const agentPhoneId = agentPhone?.phoneId as number | undefined;

          if (
            agentPhoneId !== undefined &&
            phoneIdsToRemove.has(agentPhoneId)
          ) {
            const { phoneNumbers, twilioAccountId: _tid, ...agentWithoutPhone } =
              agent;
            return {
              ...agentWithoutPhone,
              state: 'Inactivo',
            };
          }
          return agent;
        });

        updatedPhoneNumbers = phoneNumbersArray.filter(
          (phone) => !phoneIdsToRemove.has(phone.phoneId as number),
        );

        updatedPhoneNumbers = this.updatePhoneNumbersState(
          updatedPhoneNumbers,
          updatedAgents,
        );
      }

      // Eliminar el index inverso para las cuentas seleccionadas
      const deletePromises = accountsToRemove.map((account) =>
        this.firestore
          .collection('twilio_index')
          .doc(account.twilioSid)
          .delete()
          .catch((err) => {
            console.error(
              `[Twilio] Error eliminando twilio_index para ${account.twilioSid}:`,
              err,
            );
          }),
      );
      await Promise.allSettled(deletePromises);

      // Actualizar twilio y, si aplica, números/agentes afectados por la cuenta eliminada
      const updatePayload: Record<string, unknown> = {};
      if (updatedTwilioArray.length > 0) {
        updatePayload.twilio = updatedTwilioArray;
      } else {
        updatePayload.twilio = FieldValue.delete();
      }
      if (phoneIdsToRemove.size > 0) {
        updatePayload.phoneNumbers = updatedPhoneNumbers;
        updatePayload.agents = updatedAgents;
      }
      await userDocRef.update(updatePayload);

      return {
        message:
          twilioAccountId !== undefined
            ? 'Cuenta de Twilio eliminada correctamente.'
            : 'Todas las cuentas de Twilio han sido eliminadas correctamente.',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al eliminar la cuenta de Twilio: ${(error as Error).message}`,
      );
    }
  }
}
