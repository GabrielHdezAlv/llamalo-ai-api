import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { getFirestore } from '../firebase/firebase.config';

@Injectable()
export class AgentsService {
  private firestore = getFirestore();

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

  // ✅ Obtener todas las voces disponibles
  async getAllAgents() {
    try {
      const colRef = this.firestore.collection('voices');
      const snapshot = await colRef.get();

      if (snapshot.empty) {
        throw new NotFoundException('No se encontraron voces.');
      }

      // Mapear los documentos a objetos Voice
      const voices = snapshot.docs.map((doc) => doc.data());

      return voices;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener las voces: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Crear nuevo agente
  async createAgent(userId: string, agentConfig: SetAgentConfigDto) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Preparar número
      const newCountryCode = agentConfig.phoneNumbers.countryCode;
      const newNumber = agentConfig.phoneNumbers.number.toString();

      // Verificar si el número ya existe en phoneNumbers[]
      const existingPhoneIndex = phoneNumbersArray.findIndex(
        (phone) =>
          (phone.countryCode as string) === newCountryCode &&
          (phone.number as string) === newNumber,
      );

      let phoneId: number;
      if (existingPhoneIndex !== -1) {
        // Si el número existe en phoneNumbers[] pero no está en uso, reutilizar phoneId
        const existingPhone = phoneNumbersArray[existingPhoneIndex] as {
          phoneId: number;
        };
        phoneId = existingPhone.phoneId;
      } else {
        // Generar nuevo phoneId y agregar a phoneNumbers[]
        phoneId = Date.now();
        phoneNumbersArray.push({
          phoneId: phoneId,
          countryCode: newCountryCode,
          number: newNumber,
          state: 'Activo', // Será activo porque se está usando en el nuevo agente
          importedBy: 'Twilio',
        });
      }

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: newCountryCode,
        number: newNumber,
      };

      // Crear nuevo agente
      const newAgent = {
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        label: agentConfig.label,
        state: agentConfig.state || 'Activo',
        parameters: agentConfig.parameters,
        totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
      };

      // Si hay estructura antigua, migrar primero
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1; // Un timestamp anterior
        const legacyCountryCode = (legacyAgent.countryCode as string) || '';
        const legacyNumber = (legacyAgent.phoneNumber as number)?.toString() || '';

        // Validar que el número legacy no esté en uso
        const legacyNumberInUse = agentsArray.some((agent) => {
          const agentPhone = agent.phoneNumbers as Record<string, unknown> | undefined;
          if (!agentPhone) return false;
          return (
            (agentPhone.countryCode as string) === legacyCountryCode &&
            (agentPhone.number as string) === legacyNumber
          );
        });

        if (!legacyNumberInUse && legacyNumber) {
          const legacyPhoneNumbers = {
            phoneId: legacyPhoneId,
            countryCode: legacyCountryCode,
            number: legacyNumber,
            state: 'Activo', // Será activo porque se está usando en el agente migrado
            importedBy: 'Twilio',
          };

          const migratedAgent = {
            name: (legacyAgent.name as string) || '',
            type: 'inbound', // Valor por defecto
            language:
              typeof legacyAgent.language === 'string'
                ? legacyAgent.language
                : (legacyAgent.language as Record<string, string>)?.code || 'es',
            voiceId: (legacyAgent.voiceId as string) ||
              (legacyAgent.labsId as string) ||
              '',
            firstInteraction: (legacyAgent.firstInteraction as string) || '',
            agentInstruction: (legacyAgent.agentInstruction as string) || '',
            phoneNumbers: legacyPhoneNumbers,
            label: '',
            state: 'Activo',
            parameters: {
              stability: 0.5,
              similarity: 0.75,
              style: 0.0,
              boost: false,
              speed: 1.0,
            },
            totalMinutes: 0,
          };

          agentsArray.push(migratedAgent);

          // Agregar número legacy a phoneNumbers[] si no existe
          const legacyExists = phoneNumbersArray.some(
            (phone) =>
              (phone.countryCode as string) === legacyCountryCode &&
              (phone.number as string) === legacyNumber,
          );
          if (!legacyExists) {
            phoneNumbersArray.push(legacyPhoneNumbers);
          }
        }
      }

      // Agregar el nuevo agente al array
      agentsArray.push(newAgent);
      const newIndex = agentsArray.length - 1;

      // Actualizar el estado de todos los phoneNumbers basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar ambos arrays en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Agente creado correctamente.',
        agent: newAgent,
        index: newIndex,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al crear el agente: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Listar todos los agentes del usuario
  async getUserAgents(userId: string) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};

      // Si hay estructura antigua, incluirla en la respuesta
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1;
        const legacyPhoneNumbers = {
          phoneId: legacyPhoneId,
          countryCode: (legacyAgent.countryCode as string) || '',
          number: (legacyAgent.phoneNumber as number)?.toString() || '',
          state: 'Activo' as const, // Será activo porque se está usando en el agente legacy
          importedBy: 'Twilio',
        };

        const migratedAgent = {
          name: (legacyAgent.name as string) || '',
          type: 'inbound',
          language:
            typeof legacyAgent.language === 'string'
              ? legacyAgent.language
              : (legacyAgent.language as Record<string, string>)?.code || 'es',
          voiceId: (legacyAgent.voiceId as string) ||
            (legacyAgent.labsId as string) ||
            '',
          firstInteraction: (legacyAgent.firstInteraction as string) || '',
          agentInstruction: (legacyAgent.agentInstruction as string) || '',
          phoneNumbers: legacyPhoneNumbers,
          label: '',
          state: 'Activo',
          parameters: {
            stability: 0.5,
            similarity: 0.75,
            style: 0.0,
            boost: false,
            speed: 1.0,
          },
          totalMinutes: 0,
        };

        return {
          agents: [migratedAgent, ...agentsArray],
        };
      }

      return {
        agents: agentsArray,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener los agentes: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Actualizar agente específico por índice
  async updateAgent(
    userId: string,
    index: number,
    agentConfig: SetAgentConfigDto,
  ) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Validar que el índice existe
      if (index < 0 || index >= agentsArray.length) {
        throw new BadRequestException(
          `Índice de agente inválido. El usuario tiene ${agentsArray.length} agente(s).`,
        );
      }

      // Obtener agente existente
      const existingAgent = { ...agentsArray[index] };
      const existingPhone = existingAgent.phoneNumbers as Record<
        string,
        unknown
      > | undefined;
      const existingCountryCode = existingPhone?.countryCode as string;
      const existingNumber = existingPhone?.number as string;

      // Preparar nuevo número
      const newCountryCode = agentConfig.phoneNumbers.countryCode;
      const newNumber = agentConfig.phoneNumbers.number.toString();

      // Verificar si el número está cambiando
      const numberChanged =
        existingCountryCode !== newCountryCode ||
        existingNumber !== newNumber;

      // Determinar phoneId
      let phoneId: number;
      if (numberChanged) {
        // Si cambió el número, verificar si existe en phoneNumbers[]
        const existingPhoneIndex = phoneNumbersArray.findIndex(
          (phone) =>
            (phone.countryCode as string) === newCountryCode &&
            (phone.number as string) === newNumber,
        );

        if (existingPhoneIndex !== -1) {
          // Reutilizar phoneId existente
          const existingPhoneInArray = phoneNumbersArray[
            existingPhoneIndex
          ] as { phoneId: number };
          phoneId = existingPhoneInArray.phoneId;
        } else {
          // Generar nuevo phoneId y agregar a phoneNumbers[]
          phoneId = Date.now();
          phoneNumbersArray.push({
            phoneId: phoneId,
            countryCode: newCountryCode,
            number: newNumber,
            state: 'Activo', // Será activo porque se está usando en el agente actualizado
            importedBy: 'Twilio',
          });
        }
      } else {
        // Si no cambió el número, mantener el phoneId existente
        phoneId = (existingPhone?.phoneId as number) || Date.now();
      }

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: newCountryCode,
        number: newNumber,
      };

      // Actualizar agente
      const updatedAgent = {
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        label: agentConfig.label,
        state: agentConfig.state || 'Activo',
        parameters: agentConfig.parameters,
        totalMinutes: (existingAgent.totalMinutes as number) || 0, // Mantener valor existente, no se acepta del request
      };

      // Actualizar en el array
      agentsArray[index] = updatedAgent;

      // Actualizar el estado de todos los phoneNumbers basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar ambos arrays en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Agente actualizado correctamente.',
        agent: updatedAgent,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al actualizar el agente: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Eliminar agente por índice
  async deleteAgent(userId: string, index: number) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      // Validar que el índice existe
      if (index < 0 || index >= agentsArray.length) {
        throw new BadRequestException(
          `Índice de agente inválido. El usuario tiene ${agentsArray.length} agente(s).`,
        );
      }

      // Eliminar agente del array
      agentsArray.splice(index, 1);

      // Obtener phoneNumbers para actualizar su estado
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Actualizar el estado de todos los phoneNumbers basado en los agentes restantes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Agente eliminado correctamente.',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al eliminar el agente: ${(error as Error).message}`,
      );
    }
  }

  // ⚠️ DEPRECATED: Mantener por compatibilidad temporal
  async setAgentConfig(userId: string, agentConfig: SetAgentConfigDto) {
    try {
      // Obtener la referencia al documento del usuario
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray = (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};

      // Determinar si usar nueva estructura (agents[]) o antigua (agent)
      const useNewStructure =
        agentsArray.length > 0 ||
        !legacyAgent ||
        Object.keys(legacyAgent).length === 0;

      let hasChanges = false;
      const updates: Record<string, unknown> = {};

      if (useNewStructure) {
        // Nueva estructura: trabajar con agents[]
        let firstAgent = agentsArray.length > 0 ? { ...agentsArray[0] } : null;

        // Generar phoneId si no existe
        let phoneId = 0;
        if (firstAgent?.phoneNumbers) {
          const existingPhone = firstAgent.phoneNumbers as Record<string, unknown>;
          phoneId = (existingPhone.phoneId as number) || 0;
        }
        // Si no hay phoneId, generar uno nuevo basado en timestamp
        if (phoneId === 0) {
          phoneId = Date.now();
        }

        // Preparar phoneNumbers con phoneId
        const phoneNumbersWithId = {
          phoneId: phoneId,
          countryCode: agentConfig.phoneNumbers.countryCode,
          number: agentConfig.phoneNumbers.number.toString(), // Convertir a string para Firestore
        };

        // Si no hay agentes, crear uno nuevo
        if (!firstAgent) {
          firstAgent = {
            name: agentConfig.name,
            type: agentConfig.type,
            language: agentConfig.language,
            voiceId: agentConfig.voiceId,
            firstInteraction: agentConfig.firstInteraction,
            agentInstruction: agentConfig.agentInstruction,
            phoneNumbers: phoneNumbersWithId,
            label: agentConfig.label,
            state: agentConfig.state || 'Activo',
            parameters: agentConfig.parameters,
            totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
          };
          hasChanges = true;
        } else {
          // Actualizar campos existentes
          if (firstAgent.name !== agentConfig.name) {
            firstAgent.name = agentConfig.name;
            hasChanges = true;
          }
          if (firstAgent.type !== agentConfig.type) {
            firstAgent.type = agentConfig.type;
            hasChanges = true;
          }
          if (firstAgent.language !== agentConfig.language) {
            firstAgent.language = agentConfig.language;
            hasChanges = true;
          }
          if (firstAgent.voiceId !== agentConfig.voiceId) {
            firstAgent.voiceId = agentConfig.voiceId;
            hasChanges = true;
          }
          if (firstAgent.firstInteraction !== agentConfig.firstInteraction) {
            firstAgent.firstInteraction = agentConfig.firstInteraction;
            hasChanges = true;
          }
          if (firstAgent.agentInstruction !== agentConfig.agentInstruction) {
            firstAgent.agentInstruction = agentConfig.agentInstruction;
            hasChanges = true;
          }
          if (firstAgent.label !== agentConfig.label) {
            firstAgent.label = agentConfig.label;
            hasChanges = true;
          }
          if ((firstAgent.state as string) !== agentConfig.state) {
            firstAgent.state = agentConfig.state || 'Activo';
            hasChanges = true;
          }
          if (JSON.stringify(firstAgent.parameters) !== JSON.stringify(agentConfig.parameters)) {
            firstAgent.parameters = agentConfig.parameters;
            hasChanges = true;
          }
          // totalMinutes no se actualiza desde el request, se mantiene el valor existente

          // Actualizar phoneNumbers (mantener phoneId existente si es el mismo número)
          const existingPhone = firstAgent.phoneNumbers as Record<string, unknown>;
          const existingCountryCode = existingPhone?.countryCode as string;
          const existingNumber = existingPhone?.number as string;
          const newCountryCode = agentConfig.phoneNumbers.countryCode;
          const newNumber = agentConfig.phoneNumbers.number.toString();

          if (
            existingCountryCode !== newCountryCode ||
            existingNumber !== newNumber
          ) {
            // Si cambia el número, mantener el phoneId existente o generar uno nuevo
            firstAgent.phoneNumbers = {
              phoneId: phoneId,
              countryCode: newCountryCode,
              number: newNumber,
            };
            hasChanges = true;
          }
        }

        if (hasChanges) {
          // Actualizar o crear el array de agents
          if (agentsArray.length === 0) {
            updates.agents = [firstAgent];
          } else {
            agentsArray[0] = firstAgent;
            updates.agents = agentsArray;
          }

          // Actualizar el estado de todos los phoneNumbers basado en los agentes
          const phoneNumbersArray =
            (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
          const finalAgentsArray =
            agentsArray.length === 0 ? [firstAgent] : agentsArray;
          const updatedPhoneNumbers = this.updatePhoneNumbersState(
            phoneNumbersArray,
            finalAgentsArray,
          );
          updates.phoneNumbers = updatedPhoneNumbers;
        }
      } else {
        // Estructura antigua: mantener compatibilidad pero migrar a nueva estructura
        // Generar phoneId
        const phoneId = Date.now();

        const phoneNumbersWithId = {
          phoneId: phoneId,
          countryCode: agentConfig.phoneNumbers.countryCode,
          number: agentConfig.phoneNumbers.number.toString(),
        };

        // Crear nuevo agente con estructura completa
        const newAgent = {
          name: agentConfig.name,
          type: agentConfig.type,
          language: agentConfig.language,
          voiceId: agentConfig.voiceId,
          firstInteraction: agentConfig.firstInteraction,
          agentInstruction: agentConfig.agentInstruction,
          phoneNumbers: phoneNumbersWithId,
          label: agentConfig.label,
          state: agentConfig.state || 'Activo',
          parameters: agentConfig.parameters,
          totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
        };

        // Migrar a nueva estructura
        updates.agents = [newAgent];
        hasChanges = true;
      }

      if (hasChanges) {
        // Si se está usando estructura antigua, también actualizar phoneNumbers
        if (!useNewStructure && updates.agents) {
          const phoneNumbersArray =
            (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
          const newAgentsArray = updates.agents as Array<Record<string, unknown>>;
          
          // Asegurar que el phoneNumber tenga los campos necesarios
          const phoneId = (updates.agents[0] as Record<string, unknown>).phoneNumbers as Record<string, unknown>;
          const phoneIdValue = (phoneId.phoneId as number);
          if (phoneIdValue && !phoneNumbersArray.some(p => (p.phoneId as number) === phoneIdValue)) {
            phoneNumbersArray.push({
              phoneId: phoneIdValue,
              countryCode: phoneId.countryCode as string,
              number: phoneId.number as string,
              state: 'Activo' as const,
              importedBy: 'Twilio',
            });
          }
          
          const updatedPhoneNumbers = this.updatePhoneNumbersState(
            phoneNumbersArray,
            newAgentsArray,
          );
          updates.phoneNumbers = updatedPhoneNumbers;
        }
        
        await userDocRef.set(updates, { merge: true });
      }

      return {
        message: 'Configuración de agente actualizada correctamente.',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al procesar la configuración del agente: ${(error as Error).message}`,
      );
    }
  }
}
